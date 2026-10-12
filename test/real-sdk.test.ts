/**
 * Against the real agent-sdk (the installed package, AGENT_SDK_SRC=/path/to/agent-sdk/src/index.ts, or a checkout next to this repository): the
 * ledger the SDK keeps (added to IN PLACE, cumulative over a resumed state), its tool schemas, `needsApproval`, and the cost
 * limit that stops a turn. Skipped when there is no SDK to load. The other tests use stand-ins that behave the same way.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createAgentServer, costEstimatorFromPricing } from "../src/index.js";
import { memoryStorage } from "./helpers.js";
import { testPricing } from "./sdk-stubs.js";
import { sdk } from "./sdk.js";

const createSmartAgent = sdk?.createSmartAgent as (opts: unknown) => any;
const createTool = sdk?.createTool as (opts: unknown) => any;

function scriptedModel(script: Array<{ tool?: { name: string; args: object }; content?: string }>) {
  let i = 0;
  const model: any = {
    modelName: "m1",
    bindTools() { return model; },
    async invoke() {
      const step = script[Math.min(i, script.length - 1)]!;
      i++;
      const msg: any = {
        role: "assistant",
        content: step.content ?? "",
        usage_metadata: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
      };
      if (step.tool) msg.tool_calls = [{ id: `c${i}`, type: "function", function: { name: step.tool.name, arguments: JSON.stringify(step.tool.args) } }];
      return msg;
    },
  };
  return model;
}

const deploy = sdk && createTool({
  name: "deploy",
  description: "deploys",
  schema: z.object({ version: z.string() }),
  needsApproval: true,
  func: async ({ version }: any) => `deployed ${version}`,
});
const noop = sdk && createTool({ name: "noop", description: "n", schema: z.object({}), func: async () => "ok" });

describe.skipIf(!sdk)("real agent-sdk", () => {
  it("regenerates and edits: the model is only given the part of the transcript that is left", async () => {
    const seen: string[][] = [];
    let n = 0;
    const model: any = {
      modelName: "m1",
      bindTools() { return model; },
      async invoke(messages: any[]) {
        seen.push(messages.filter((m) => m.role === "user" || m.role === "assistant").map((m) => `${m.role}:${typeof m.content === "string" ? m.content : JSON.stringify(m.content)}`));
        n++;
        return { role: "assistant", content: `reply ${n}`, usage_metadata: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } };
      },
    };
    const agent = createSmartAgent({ name: "t", model, tools: [noop] as any } as any);
    const server = createAgentServer({ basePath: "/api", storage: await memoryStorage(), runs: { sweepIntervalMs: 0, recoverOnStart: false } });
    server.registerSDKAgent("a", agent);
    const call = (m: string, p: string, body?: unknown) => server.handleRoute(m, p, { query: {}, body });
    const id = ((await call("POST", "/conversations", { agentId: "a" })).body as any).conversation.id;
    const first = (await call("POST", `/conversations/${id}/messages`, { message: "one" })).body as any;
    await call("POST", `/conversations/${id}/messages`, { message: "two" });
    expect(seen.at(-1)).toEqual(["user:one", "assistant:reply 1", "user:two"]);

    // regenerate the newest answer: the model sees the transcript up to the question it answers
    const second = (await call("GET", `/conversations/${id}`)).body as any;
    const newest = second.messages.at(-1);
    const again = await call("POST", `/conversations/${id}/messages/${newest.id}/regenerate`);
    expect(again.status).toBe(200);
    expect(seen.at(-1)).toEqual(["user:one", "assistant:reply 1", "user:two"]);
    expect((again.body as any).response.content).toBe("reply 3");
    expect((again.body as any).response.metadata.previousContent).toEqual([expect.objectContaining({ content: "reply 2" })]);

    // edit the first message: everything after it is gone
    const edited = await call("POST", `/conversations/${id}/messages/${first.message.id}/edit`, { content: "uno" });
    expect(edited.status).toBe(200);
    expect(seen.at(-1)).toEqual(["user:uno"]);
    const after = ((await call("GET", `/conversations/${id}`)).body as any).messages.map((m: any) => m.content);
    expect(after).toEqual(["uno", "reply 4"]);
  });

  it("pauses, validates edits, resumes with delta usage", async () => {
    const model = scriptedModel([{ tool: { name: "deploy", args: { version: "1.0" } } }, { content: "all done" }]);
    const agent = createSmartAgent({ name: "t", model, tools: [deploy] as any, costEstimator: costEstimatorFromPricing(testPricing) } as any);
    const server = createAgentServer({ basePath: "/api", storage: await memoryStorage(), pricing: testPricing, runs: { sweepIntervalMs: 0, recoverOnStart: false } });
    server.registerSDKAgent("a", agent);
    const call = (m: string, p: string, body?: unknown) => server.handleRoute(m, p, { query: {}, body });
    const id = ((await call("POST", "/conversations", { agentId: "a" })).body as any).conversation.id;
    const paused = (await call("POST", `/conversations/${id}/messages`, { message: "go" })).body as any;
    expect(paused.status).toBe("requires_action");
    const actionId = paused.pendingActions[0].id;

    const bad = await call("POST", `/conversations/${id}/actions/${actionId}`, { resolution: { type: "tool_approval", decision: "allow", approvedArgs: { version: 2 } } });
    expect(bad.status).toBe(400);

    const ok = await call("POST", `/conversations/${id}/actions/${actionId}`, { resolution: { type: "tool_approval", decision: "allow", approvedArgs: { version: "2.0" } } });
    expect((ok.body as any).usage).toMatchObject({ inputTokens: 100, outputTokens: 50 });
    const conv = ((await call("GET", `/conversations/${id}`)).body as any).conversation;
    expect(conv.spentUsd).toBeCloseTo(0.4, 8);
  });

  it("stops on the budget in the middle and continues from the real carried state", async () => {
    const script = [
      { tool: { name: "noop", args: {} } }, { tool: { name: "noop", args: {} } }, { tool: { name: "noop", args: {} } },
      { tool: { name: "noop", args: {} } }, { tool: { name: "noop", args: {} } }, { content: "finished" },
    ];
    const model = scriptedModel(script);
    const agent = createSmartAgent({ name: "t", model, tools: [noop] as any, costEstimator: costEstimatorFromPricing(testPricing) } as any);
    const server = createAgentServer({
      basePath: "/api", storage: await memoryStorage(), pricing: testPricing, budget: { maxCostUsd: 0.3, onReach: "pause" }, authorizeBudget: () => true,
      runs: { sweepIntervalMs: 0, recoverOnStart: false },
    });
    server.registerSDKAgent("a", agent);
    const call = (m: string, p: string, body?: unknown) => server.handleRoute(m, p, { query: {}, body });
    const id = ((await call("POST", "/conversations", { agentId: "a" })).body as any).conversation.id;
    const first = (await call("POST", `/conversations/${id}/messages`, { message: "work" })).body as any;
    expect(first.stopReason).toBe("budget_reached");
    const raised = await call("PATCH", `/conversations/${id}`, { budget: { maxCostUsd: 5 } });
    const cont = await call("POST", `/conversations/${id}/continue`, {});
    expect(cont.status).toBe(200);
    expect((cont.body as any).response.content).toBe("finished");
    const conv = ((await call("GET", `/conversations/${id}`)).body as any).conversation;
    // 6 model calls in all, $0.20 each
    expect(conv.spentUsd).toBeCloseTo(1.2, 8);
  });
});
