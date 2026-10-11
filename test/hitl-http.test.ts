/**
 * The approval and budget routes over real HTTP: the Node handler, Fastify and Express. A tool name with a space and a slash in it, an answer
 * that lapsed, a budget refused with 402.
 */

import http from "node:http";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentServer, createNodeHandler } from "../src/index.js";
import type { AgentServerConfig, AgentRegistration } from "../src/index.js";
import { mountOnFastify } from "../src/adapters/fastify.js";
import { listen, memoryStorage } from "./helpers.js";
import { pausingStub, steppingStub, testPricing } from "./sdk-stubs.js";

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

const quiet = { runs: { sweepIntervalMs: 0, recoverOnStart: false } };

async function node(agent: unknown, config: Partial<AgentServerConfig> = {}) {
  const server = createAgentServer({
    basePath: "/api",
    storage: await memoryStorage(),
    agents: [{ info: { id: "a", name: "A" }, sdkAgent: agent } as AgentRegistration],
    ...quiet,
    ...config,
  });
  const handle = createNodeHandler(server);
  const app = http.createServer(async (req, res) => {
    if (!(await handle(req, res))) {
      res.statusCode = 418;
      res.end();
    }
  });
  const { url, close } = await listen(app);
  closers.push(close);
  return { url: `${url}/api`, server };
}

async function fastify(agent: unknown, config: Partial<AgentServerConfig> = {}) {
  const server = createAgentServer({
    basePath: "/ignored",
    storage: await memoryStorage(),
    agents: [{ info: { id: "a", name: "A" }, sdkAgent: agent } as AgentRegistration],
    ...quiet,
    ...config,
  });
  const app = Fastify();
  mountOnFastify(app, server, { prefix: "/api" });
  await app.listen({ port: 0, host: "127.0.0.1" });
  closers.push(() => app.close());
  const { port } = app.server.address() as { port: number };
  return { url: `http://127.0.0.1:${port}/api`, server };
}

const post = (url: string, body?: unknown, method = "POST") =>
  fetch(url, { method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });

for (const [name, boot] of [["Node handler", node], ["Fastify", fastify]] as const) {
  describe(`approvals and budgets over HTTP: ${name}`, () => {
    it("remembers a tool with an awkward name, lists it, and forgets it", async () => {
      const tool = "web search/v2 (beta)";
      const { url } = await boot(pausingStub({ toolName: tool }));
      const { conversation } = (await (await post(`${url}/conversations`, { agentId: "a" })).json()) as any;
      const id = conversation.id;
      const paused = (await (await post(`${url}/conversations/${id}/messages`, { message: "go" })).json()) as any;
      expect(paused.pendingActions[0].toolName).toBe(tool);
      const answered = await post(`${url}/conversations/${id}/actions/ap1`, { resolution: { type: "tool_approval", decision: "allow", rememberForSession: true } });
      expect(answered.status).toBe(200);

      const listed = (await (await fetch(`${url}/conversations/${id}/remembered-tools`)).json()) as any;
      expect(listed.tools).toEqual([tool]);
      const gone = await fetch(`${url}/conversations/${id}/remembered-tools/${encodeURIComponent(tool)}`, { method: "DELETE" });
      expect(gone.status).toBe(200);
      expect(((await gone.json()) as any).tools).toEqual([]);
      expect((await fetch(`${url}/conversations/${id}/remembered-tools/${encodeURIComponent(tool)}`, { method: "DELETE" })).status).toBe(404);
    });

    it("answers 410 for a request that lapsed, 409 for one that is gone, with the error envelope", async () => {
      const { url } = await boot(pausingStub({ expiresAt: () => new Date(Date.now() + 40).toISOString() }));
      const { conversation } = (await (await post(`${url}/conversations`, { agentId: "a" })).json()) as any;
      await post(`${url}/conversations/${conversation.id}/messages`, { message: "go" });
      await new Promise((resolve) => setTimeout(resolve, 80));
      const lapsed = await post(`${url}/conversations/${conversation.id}/actions/ap1`, { resolution: { type: "tool_approval", decision: "allow" } });
      expect(lapsed.status).toBe(410);
      expect(((await lapsed.json()) as any).error.code).toBe("action_expired");
      const gone = await post(`${url}/conversations/${conversation.id}/actions/nope`, { resolution: { type: "tool_approval", decision: "allow" } });
      expect(gone.status).toBe(409);
    });

    it("stops a conversation on its budget (402), and carries it on after PATCH and POST /continue", async () => {
      const { url } = await boot(steppingStub({ steps: 5 }), {
        pricing: testPricing,
        budget: { maxCostUsd: 0.5, onReach: "pause" },
        authorizeBudget: () => true,
      });
      const { conversation } = (await (await post(`${url}/conversations`, { agentId: "a" })).json()) as any;
      const id = conversation.id;
      expect(conversation.budget).toEqual({ maxCostUsd: 0.5, onReach: "pause" });

      const first = (await (await post(`${url}/conversations/${id}/messages`, { message: "work" })).json()) as any;
      expect(first.stopReason).toBe("budget_reached");
      const refused = await post(`${url}/conversations/${id}/messages`, { message: "more" });
      expect(refused.status).toBe(402);
      expect(((await refused.json()) as any).error.code).toBe("budget_reached");
      expect((await post(`${url}/conversations/${id}/continue`, {})).status).toBe(402);

      const raised = await post(`${url}/conversations/${id}`, { budget: { maxCostUsd: 10 } }, "PATCH");
      expect(raised.status).toBe(200);
      expect(((await raised.json()) as any).runtime.status).toBe("idle");
      const resumed = await post(`${url}/conversations/${id}/continue`, {});
      expect(resumed.status).toBe(200);
      expect(((await resumed.json()) as any).response.content).toBe("finished after 5 steps");
      const again = await post(`${url}/conversations/${id}/continue`);
      expect(again.status).toBe(409);
      expect(((await again.json()) as any).error.code).toBe("nothing_to_continue");
    });

    it("answers a refused budget change with 403 and the envelope", async () => {
      const { url } = await boot(steppingStub({ steps: 1 }), { pricing: testPricing, budget: { maxCostUsd: 1, onReach: "pause" } });
      const { conversation } = (await (await post(`${url}/conversations`, { agentId: "a" })).json()) as any;
      const res = await post(`${url}/conversations/${conversation.id}`, { budget: { maxCostUsd: 5 } }, "PATCH");
      expect(res.status).toBe(403);
      expect(((await res.json()) as any).error).toMatchObject({ code: "budget_forbidden" });
    });
  });
}
