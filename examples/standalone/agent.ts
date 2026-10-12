/**
 * The agents of the example: an agent-sdk agent (tools that need approval, questions, the conversation's files) and a small
 * host-backed agent. The model is a scripted stand-in unless LLM_BASE_URL points at an OpenAI-compatible API.
 */

import { createSmartAgent, createTool, createProvider, fromNativeProvider } from "@cognipeer/agent-sdk";
import {
  costEstimatorFromPricing,
  createImageAwareTokenCounter,
  createSessionFileTools,
  withSessionImages,
} from "@cognipeer/agent-server";
import type { HostAgentDefinition, PricingFn } from "@cognipeer/agent-server";
import { z } from "zod";
import { examplePricing, mockModel } from "./mock-model.js";

/** What a token costs, by model name. Real models: add yours here (or build the function from your price list). */
export const pricing: PricingFn = (model) => {
  const mock = examplePricing(model);
  if (mock) return mock;
  if (/^gpt-4o-mini/.test(model)) return { inputPerToken: 0.15e-6, outputPerToken: 0.6e-6 };
  return undefined;
};

/** The model the agents use: a real OpenAI-compatible API when LLM_BASE_URL is set, else the scripted stand-in. */
export function createModel(env: Record<string, string | undefined> = process.env) {
  if (env.LLM_BASE_URL) {
    return fromNativeProvider(
      createProvider({ provider: "openai-compatible", apiKey: env.LLM_API_KEY ?? "none", baseURL: env.LLM_BASE_URL }),
      { model: env.LLM_MODEL ?? "gpt-4o-mini" }
    );
  }
  return mockModel({ slowMs: Number(env.MOCK_SLOW_MS) || undefined });
}

/** A tool that needs a person's OK before it runs. */
const deployService = createTool({
  name: "deploy_service",
  description: "Deploys a service to production.",
  schema: z.object({ service: z.string().describe("Which service"), version: z.string().describe("Which version") }),
  needsApproval: true,
  approvalPrompt: "Allow the agent to deploy this service?",
  func: async ({ service, version }: { service: string; version: string }) => `${service} ${version} is live`,
});

/**
 * An agent-sdk agent. `createSessionFileTools()` lets it read what the person attached, `withSessionImages` lets it see pictures
 * (by reference: the server reads the bytes when the model is called), and `costEstimatorFromPricing` lets a conversation's budget stop it
 * in the middle of a turn.
 */
export function createExampleAgent(model: unknown = createModel()) {
  return createSmartAgent({
    name: "Assistant",
    model: withSessionImages(model as never) as never,
    tools: [deployService, ...createSessionFileTools({ viewImage: true })] as never,
    humanInTheLoop: { askUser: true },
    tokenCounter: createImageAwareTokenCounter(),
    costEstimator: costEstimatorFromPricing(pricing),
    limits: { maxToolCalls: 8 },
  } as never);
}

/**
 * A host-backed agent: its work happens in your own backend (here, a few lines of code). It reports progress with `emit`, asks for
 * approval by returning `pendingActions`, and the server stores the messages, the pause and the events.
 */
export function createHostEchoAgent(): HostAgentDefinition {
  const pause = (service: string) => [
    {
      id: `approve_${Date.now().toString(36)}`,
      type: "tool_approval" as const,
      toolName: "deploy_service",
      title: `Deploy ${service}?`,
      args: { service },
    },
  ];
  return {
    info: {
      id: "host-echo",
      name: "Host echo",
      description: "A host-backed agent: streams its answer, and asks before it deploys.",
      capabilities: { toolApproval: true },
    },
    async invoke({ message }, { emit, signal }) {
      const deploy = /\bdeploy\s+([\w.-]+)/i.exec(message);
      if (deploy) {
        emit({ type: "text", text: `I can deploy ${deploy[1]}, but I need your approval first.` });
        return { pendingActions: pause(deploy[1]!) };
      }
      const words = `You said: "${message}"`.split(" ");
      for (const [i, word] of words.entries()) {
        if (signal.aborted) break;
        emit({ type: "text", text: i < words.length - 1 ? `${word} ` : word });
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      emit({ type: "usage", usage: { inputTokens: message.length, outputTokens: message.length * 2 } });
      return { content: "" };
    },
    async resolveAction({ action, resolution }, { emit }) {
      const service = action.type === "tool_approval" ? String(action.args?.service ?? "it") : "it";
      const approved = resolution.type === "tool_approval" && resolution.decision === "allow";
      if (approved) {
        emit({ type: "tool_use", id: "deploy-1", name: "deploy_service", args: { service } });
        emit({ type: "tool_result", id: "deploy-1", result: `${service} is live` });
      }
      return { content: approved ? `Deployed ${service}.` : `Left ${service} alone.` };
    },
  };
}
