/**
 * Against the real agent-sdk (a checkout next to this repository, or AGENT_SDK_SRC=/path/to/agent-sdk/src/index.ts): the
 * ledger the SDK keeps (added to IN PLACE, cumulative over a resumed state), its tool schemas, `needsApproval`, and the cost
 * limit that stops a turn. Skipped when there is no SDK to load. The other tests use stand-ins that behave the same way.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createAgentServer, costEstimatorFromPricing } from "../src/index.js";
import { memoryStorage } from "./helpers.js";
import { testPricing } from "./sdk-stubs.js";

const sdkPath = path.resolve(process.env.AGENT_SDK_SRC ?? path.join(__dirname, "../../agent-sdk/src/index.ts"));
const sdk = existsSync(sdkPath) ? ((await import(/* @vite-ignore */ sdkPath)) as any) : undefined;
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
