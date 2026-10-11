/**
 * The pure parts of approvals and budgets: usage normalisation, budget rules, argument checks, deadlines, the record
 * on the paused message.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { costEstimatorFromPricing } from "../src/index.js";
import type { PendingAction } from "../src/index.js";
import {
  detectPendingActions,
  earliestDeadline,
  isExpired,
  openSnapshot,
  publicState,
  readBudget,
  settleSnapshot,
  stampDeadlines,
  withHiddenStores,
  writeBudget,
  writeHitl,
} from "../src/hitl.js";
import { findToolSchema, toJsonSchema, validateAgainstSchema } from "../src/schema.js";
import { budgetChangeKind, isCostLimitDetail, ledgerCostUsd, normalizeUsage, parseBudget, priceTokens, roundUsd } from "../src/usage.js";
import { ledgerCost, testPricing, withCall } from "./sdk-stubs.js";

describe("normalizeUsage", () => {
  it("reads agent-sdk's ledger: tokens, totals over every model, cached tokens", () => {
    let ledger = withCall(undefined, "m1", 100, 50);
    ledger = withCall(ledger, "other", 10, 5, 4);
    expect(normalizeUsage(ledger)).toEqual({ inputTokens: 110, outputTokens: 55, totalTokens: 165, cachedInputTokens: 4 });
  });

  it("counts a resumed run only for what it used after the ledger it started from", () => {
    const before = withCall(withCall(undefined, "m1", 100, 50), "m1", 20, 10);
    const after = withCall(before, "m1", 7, 3);
    expect(normalizeUsage(after, { previous: before })).toEqual({ inputTokens: 7, outputTokens: 3, totalTokens: 10 });
    // a run that made no call of its own used nothing
    expect(normalizeUsage(before, { previous: before })).toEqual({ inputTokens: 0, outputTokens: 0, totalTokens: 0 });
    // a model the earlier ledger did not have counts in full; a ledger that shrank never goes negative
    const other = withCall(before, "new-model", 5, 1);
    expect(normalizeUsage(other, { previous: before })).toEqual({ inputTokens: 5, outputTokens: 1, totalTokens: 6 });
    expect(normalizeUsage(withCall(undefined, "m1", 1, 1), { previous: before })).toEqual({ inputTokens: 0, outputTokens: 0, totalTokens: 0 });
  });

  it("prices per model, with the cached discount, and only the models it has a price for", () => {
    let ledger = withCall(undefined, "m1", 100, 50);
    ledger = withCall(ledger, "cached-model", 1000, 100, 500);
    ledger = withCall(ledger, "unpriced", 999, 999);
    const usage = normalizeUsage(ledger, { pricing: testPricing })!;
    expect(usage.costUsd).toBeCloseTo(0.2 + (500 * 0.001 + 500 * 0.0001 + 100 * 0.002), 8);
    expect(normalizeUsage(withCall(undefined, "unpriced", 1, 1), { pricing: testPricing })).not.toHaveProperty("costUsd");
    expect(normalizeUsage(ledger)).not.toHaveProperty("costUsd");
  });

  it("answers nothing for an empty ledger or something that is not a report", () => {
    expect(normalizeUsage({ perRequest: [], totals: {} })).toBeUndefined();
    for (const bad of [undefined, null, 5, "x", [], {}]) expect(normalizeUsage(bad)).toBeUndefined();
  });

  it("passes the flat shape of a provider or a handler through, and prices it by name or takes the cost it gives", () => {
    expect(normalizeUsage({ inputTokens: 1, outputTokens: 2, totalTokens: 3 })).toEqual({ inputTokens: 1, outputTokens: 2, totalTokens: 3 });
    expect(normalizeUsage({ prompt_tokens: 4, completion_tokens: 5 })).toEqual({ inputTokens: 4, outputTokens: 5 });
    expect(normalizeUsage({ inputTokens: 100, outputTokens: 50 }, { pricing: testPricing, model: "m1" })!.costUsd).toBeCloseTo(0.2, 8);
    expect(normalizeUsage({ inputTokens: 100, outputTokens: 50, model: "m1" }, { pricing: testPricing })!.costUsd).toBeCloseTo(0.2, 8);
    expect(normalizeUsage({ inputTokens: 100, outputTokens: 50, costUsd: 9 }, { pricing: testPricing, model: "m1" })!.costUsd).toBe(9);
    expect(normalizeUsage({ costUsd: 0.5 })).toEqual({ costUsd: 0.5 });
    expect(normalizeUsage({ inputTokens: 1 }, { pricing: testPricing })).not.toHaveProperty("costUsd");
  });

  it("keeps floating point dust out of a cost", () => {
    expect(roundUsd(0.1 + 0.2)).toBe(0.3);
    expect(priceTokens({ inputPerToken: 0.1, outputPerToken: 0.2 }, { input: 1, output: 1 })).toBeCloseTo(0.3, 10);
  });

  it("prices a whole ledger, and an SDK estimator built from the same prices agrees", () => {
    const ledger = withCall(withCall(undefined, "m1", 100, 50), "cached-model", 1000, 100, 500);
    expect(ledgerCostUsd(ledger, testPricing)).toBeCloseTo(ledgerCost(ledger), 8);
    expect(ledgerCostUsd(ledger, undefined)).toBe(0);
    expect(ledgerCostUsd(undefined, testPricing)).toBe(0);
    const estimate = costEstimatorFromPricing(testPricing);
    expect(estimate({ modelName: "m1", inputTokens: 100, outputTokens: 50 })).toBeCloseTo(0.2, 8);
    expect(estimate({ modelName: "cached-model", inputTokens: 1000, outputTokens: 100, cachedInputTokens: 500 })).toBeCloseTo(0.75, 8);
    expect(estimate({ modelName: "unpriced", inputTokens: 1, outputTokens: 1 })).toBe(0);
    expect(estimate({ inputTokens: 1, outputTokens: 1 })).toBe(0);
  });
});

describe("budgets", () => {
  it("reads a budget as a request or a setting spells it", () => {
    expect(parseBudget({ maxCostUsd: 5 })).toEqual({ ok: true, budget: { maxCostUsd: 5, onReach: "pause" } });
    expect(parseBudget({ max_cost_usd: 1.5, on_reach: "stop" })).toEqual({ ok: true, budget: { maxCostUsd: 1.5, onReach: "stop" } });
    for (const bad of [null, undefined, 5, "x", [], {}, { maxCostUsd: 0 }, { maxCostUsd: -1 }, { maxCostUsd: Infinity }, { maxCostUsd: "1" }, { maxCostUsd: 1, onReach: "halt" }]) {
      expect(parseBudget(bad).ok, JSON.stringify(bad)).toBe(false);
    }
    expect((parseBudget({}, "agent budget") as { message: string }).message).toContain("agent budget.maxCostUsd");
  });

  it("tells lowering from raising", () => {
    const pause = (maxCostUsd: number) => ({ maxCostUsd, onReach: "pause" as const });
    const stop = (maxCostUsd: number) => ({ maxCostUsd, onReach: "stop" as const });
    expect(budgetChangeKind(null, null)).toBe("same");
    expect(budgetChangeKind(null, pause(5))).toBe("lower");
    expect(budgetChangeKind(pause(5), null)).toBe("raise");
    expect(budgetChangeKind(pause(5), pause(5))).toBe("same");
    expect(budgetChangeKind(pause(5), pause(4))).toBe("lower");
    expect(budgetChangeKind(pause(5), pause(6))).toBe("raise");
    // "pause" lets the conversation be continued, so going from "stop" to it loosens the limit
    expect(budgetChangeKind(stop(5), pause(5))).toBe("raise");
    expect(budgetChangeKind(pause(5), stop(5))).toBe("lower");
    expect(budgetChangeKind(pause(5), stop(9))).toBe("raise");
    expect(budgetChangeKind(stop(5), stop(5))).toBe("same");
  });

  it("recognises the SDK's wording of a cost-limit stop", () => {
    expect(isCostLimitDetail("maxCostUsd ($0.5) exceeded (actual: $0.6000)")).toBe(true);
    expect(isCostLimitDetail("maxWallClockMs (1000ms) exceeded")).toBe(false);
    expect(isCostLimitDetail(undefined)).toBe(false);
  });
});

describe("checking edited arguments", () => {
  const zodSchema = z.object({ version: z.string(), replicas: z.number().int().min(1).optional() });

  it("zod: accepts what fits, names what does not", () => {
    expect(validateAgainstSchema(zodSchema, { version: "1" })).toBeNull();
    expect(validateAgainstSchema(zodSchema, { version: "1", replicas: 2 })).toBeNull();
    expect(validateAgainstSchema(zodSchema, { version: 1 })).toMatch(/version/);
    expect(validateAgainstSchema(zodSchema, { version: "1", replicas: 0 })).toMatch(/replicas/);
    expect(validateAgainstSchema(zodSchema, {})).toMatch(/version/);
    expect(validateAgainstSchema(z.object({ a: z.string() }).strict(), { a: "x", b: 1 })).toBeTruthy();
  });

  it("JSON Schema: type, required, properties, additionalProperties, enum, bounds, patterns, items", () => {
    const schema = {
      type: "object",
      required: ["name"],
      additionalProperties: false,
      properties: {
        name: { type: "string", minLength: 2, maxLength: 5, pattern: "^[a-z]+$" },
        count: { type: "integer", minimum: 1, maximum: 10 },
        mode: { enum: ["a", "b"] },
        tags: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 2 },
        nested: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
        either: { anyOf: [{ type: "string" }, { type: "number" }] },
        nullable: { type: ["string", "null"] },
      },
    };
    expect(validateAgainstSchema(schema, { name: "abc", count: 3, mode: "a", tags: ["x"], nested: { ok: true }, either: 1, nullable: null })).toBeNull();
    for (const bad of [
      {},
      { name: "a" },
      { name: "abcdef" },
      { name: "ABC" },
      { name: "abc", count: 1.5 },
      { name: "abc", count: 0 },
      { name: "abc", count: 11 },
      { name: "abc", mode: "c" },
      { name: "abc", tags: [] },
      { name: "abc", tags: ["a", "b", "c"] },
      { name: "abc", tags: [1] },
      { name: "abc", nested: {} },
      { name: "abc", nested: { ok: "yes" } },
      { name: "abc", either: true },
      { name: "abc", nullable: 3 },
      { name: "abc", extra: 1 },
    ]) {
      expect(validateAgainstSchema(schema, bad), JSON.stringify(bad)).toBeTruthy();
    }
    expect(validateAgainstSchema({ type: "object" }, [])).toMatch(/object/);
    expect(validateAgainstSchema({ oneOf: [{ type: "string" }, { type: "number" }] }, true)).toBeTruthy();
    expect(validateAgainstSchema({ allOf: [{ type: "object", required: ["a"] }, { type: "object", required: ["b"] }] }, { a: 1 })).toMatch(/b/);
    expect(validateAgainstSchema({ const: 3 }, 4)).toMatch(/3/);
  });

  it("does not choke on what it does not know", () => {
    for (const odd of [undefined, null, 5, "x", [], {}, { $ref: "#/x" }, { type: "mystery" }, { pattern: "(", type: "string" }]) {
      const result = validateAgainstSchema(odd, "anything");
      expect(result === null || typeof result === "string").toBe(true);
    }
    expect(validateAgainstSchema({ type: "string", pattern: "(" }, "ok")).toBeNull();
  });

  it("finds a tool's schema where agent-sdk and MCP keep it", () => {
    const agent = {
      __runtime: {
        tools: [
          { name: "a", schema: zodSchema },
          { name: "b", parameters: { type: "object" } },
          { name: "c", inputSchema: { type: "object" } },
          { name: "d", input_schema: { type: "object" } },
          { name: "e" },
        ],
      },
    };
    expect(findToolSchema(agent, "a")).toBe(zodSchema);
    expect(findToolSchema(agent, "b")).toEqual({ type: "object" });
    expect(findToolSchema(agent, "c")).toEqual({ type: "object" });
    expect(findToolSchema(agent, "d")).toEqual({ type: "object" });
    expect(findToolSchema(agent, "e")).toBeUndefined();
    expect(findToolSchema(agent, "missing")).toBeUndefined();
    expect(findToolSchema({}, "a")).toBeUndefined();
    expect(findToolSchema(undefined, "a")).toBeUndefined();
  });
});

describe("toJsonSchema", () => {
  it("converts the zod schema of a tool: types, constraints, optional and default, nested objects, enums, unions", () => {
    const schema = z.object({
      service: z.string().min(1).max(40).describe("Which service"),
      version: z.string().regex(/^\d+$/).optional(),
      replicas: z.number().int().min(1).max(9).default(2),
      ratio: z.number().min(0).max(1),
      dryRun: z.boolean(),
      env: z.enum(["stg", "prod"]),
      kind: z.literal("blue"),
      tags: z.array(z.string()).min(1).max(5),
      labels: z.record(z.string()),
      owner: z.object({ name: z.string(), email: z.string().email().nullable() }),
      when: z.union([z.string(), z.number()]),
      note: z.string().nullable().optional(),
    });
    expect(toJsonSchema(schema)).toEqual({
      type: "object",
      properties: {
        service: { type: "string", minLength: 1, maxLength: 40, description: "Which service" },
        version: { type: "string", pattern: "^\\d+$" },
        replicas: { type: "integer", minimum: 1, maximum: 9, default: 2 },
        ratio: { type: "number", minimum: 0, maximum: 1 },
        dryRun: { type: "boolean" },
        env: { type: "string", enum: ["stg", "prod"] },
        kind: { const: "blue" },
        tags: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 5 },
        labels: { type: "object", additionalProperties: { type: "string" } },
        owner: {
          type: "object",
          properties: { name: { type: "string" }, email: { anyOf: [{ type: "string", format: "email" }, { type: "null" }] } },
          required: ["name", "email"],
        },
        when: { anyOf: [{ type: "string" }, { type: "number" }] },
        note: { anyOf: [{ type: "string" }, { type: "null" }] },
      },
      required: ["service", "ratio", "dryRun", "env", "kind", "tags", "labels", "owner", "when"],
    });
  });

  it("converts the wrappers around a schema, a strict object, an intersection and a native enum", () => {
    enum Color { Red = "red", Blue = "blue" }
    enum Level { Low, High }
    expect(toJsonSchema(z.object({ a: z.string() }).strict())).toMatchObject({ additionalProperties: false });
    expect(toJsonSchema(z.object({ a: z.string() }).catchall(z.number()))).toMatchObject({ additionalProperties: { type: "number" } });
    expect(toJsonSchema(z.object({ a: z.string().transform((v) => v.length) }))).toMatchObject({ properties: { a: { type: "string" } }, required: ["a"] });
    expect(toJsonSchema(z.object({ a: z.string().refine((v) => v !== "x") }))).toMatchObject({ properties: { a: { type: "string" } } });
    expect(toJsonSchema(z.object({ a: z.string().brand<"x">() }))).toMatchObject({ properties: { a: { type: "string" } } });
    expect(toJsonSchema(z.object({ a: z.string() }).and(z.object({ b: z.number() })))).toMatchObject({ allOf: [{ properties: { a: {} } }, { properties: { b: {} } }] });
    expect(toJsonSchema(z.nativeEnum(Color))).toEqual({ enum: ["red", "blue"] });
    expect(toJsonSchema(z.nativeEnum(Level))).toEqual({ enum: [0, 1] });
    expect(toJsonSchema(z.object({ pair: z.tuple([z.string(), z.number()]) }))).toMatchObject({
      properties: { pair: { type: "array", items: [{ type: "string" }, { type: "number" }], minItems: 2, maxItems: 2 } },
    });
    // a type this file does not know becomes "any value", so the rest of the schema still helps
    expect(toJsonSchema(z.object({ a: z.string(), b: z.map(z.string(), z.number()), c: z.any() }))).toMatchObject({
      properties: { a: { type: "string" }, b: { type: "object" }, c: {} },
      required: ["a", "b"],
    });
    // recursion ends
    const tree: z.ZodTypeAny = z.lazy(() => z.object({ name: z.string(), children: z.array(tree).optional() }));
    const converted = toJsonSchema(tree)!;
    expect(converted.type).toBe("object");
    expect(JSON.stringify(converted).length).toBeLessThan(32_000);
  });

  it("converts a zod 4 schema the same way", async () => {
    const z4 = await import("zod/v4");
    const schema = z4.object({
      service: z4.string().min(1),
      version: z4.string().regex(/^\d+\.\d+$/).optional(),
      contact: z4.string().email(),
      replicas: z4.number().int().optional(),
      env: z4.enum(["stg", "prod"]),
      tags: z4.array(z4.string()),
      note: z4.string().nullable(),
      limits: z4.record(z4.string(), z4.number()),
    });
    expect(toJsonSchema(schema)).toEqual({
      type: "object",
      properties: {
        service: { type: "string", minLength: 1 },
        version: { type: "string", pattern: "^\\d+\\.\\d+$" },
        contact: { type: "string", format: "email" },
        replicas: { type: "integer" },
        env: { type: "string", enum: ["stg", "prod"] },
        tags: { type: "array", items: { type: "string" } },
        note: { anyOf: [{ type: "string" }, { type: "null" }] },
        limits: { type: "object", additionalProperties: { type: "number" } },
      },
      required: ["service", "contact", "env", "tags", "note", "limits"],
    });
  });

  it("passes a JSON Schema on as a copy, and answers nothing for what is not a schema or is too big", () => {
    const json = { type: "object", properties: { a: { type: "string" } }, required: ["a"] };
    const copy = toJsonSchema(json)!;
    expect(copy).toEqual(json);
    expect(copy).not.toBe(json);
    for (const odd of [undefined, null, 5, "x", [], () => 1]) expect(toJsonSchema(odd)).toBeUndefined();
    expect(toJsonSchema({ type: "object", properties: Object.fromEntries(Array.from({ length: 2000 }, (_, i) => [`property_${i}`, { type: "string", description: "x".repeat(20) }])) })).toBeUndefined();
    const cyclic: Record<string, unknown> = { type: "object" };
    cyclic.self = cyclic;
    expect(toJsonSchema(cyclic)).toBeUndefined();
  });
});

describe("deadlines", () => {
  const approval = (id: string, expiresAt?: string): PendingAction => ({ id, type: "tool_approval", toolName: "t", ...(expiresAt ? { expiresAt } : {}) });

  it("gives an action without a deadline now + the timeout, and leaves one that has its own", () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    const stamped = stampDeadlines([approval("a"), approval("b", "2026-01-01T00:05:00.000Z")], 30, now);
    expect(stamped[0]!.expiresAt).toBe("2026-01-01T00:30:00.000Z");
    expect(stamped[1]!.expiresAt).toBe("2026-01-01T00:05:00.000Z");
    // never: nothing is stamped
    const untouched = [approval("a")];
    expect(stampDeadlines(untouched, 0, now)).toBe(untouched);
    expect(stampDeadlines(untouched, -5, now)).toBe(untouched);
    expect(stampDeadlines(untouched, Number.NaN, now)).toBe(untouched);
    // (the input is not changed)
    expect(untouched[0]!.expiresAt).toBeUndefined();
    // a deadline that is no time at all counts as none; one in another notation is kept as an ISO time
    const odd = stampDeadlines([approval("a", "someday"), approval("b", "2026-01-01T00:05:00Z"), approval("c", "2026-01-01")], 30, now);
    expect(odd.map((a) => a.expiresAt)).toEqual(["2026-01-01T00:30:00.000Z", "2026-01-01T00:05:00.000Z", "2026-01-01T00:00:00.000Z"]);
    expect(stampDeadlines([approval("a", "someday")], 0, now)[0]!.expiresAt).toBeUndefined();
  });

  it("knows when an action lapsed, and which deadline comes first", () => {
    const now = new Date("2026-01-01T00:10:00.000Z");
    expect(isExpired(approval("a", "2026-01-01T00:10:00.000Z"), now)).toBe(true);
    expect(isExpired(approval("a", "2026-01-01T00:10:00.001Z"), now)).toBe(false);
    expect(isExpired(approval("a"), now)).toBe(false);
    expect(earliestDeadline([approval("a", "2026-01-01T02:00:00.000Z"), approval("b", "2026-01-01T01:00:00.000Z"), approval("c")])?.toISOString()).toBe("2026-01-01T01:00:00.000Z");
    expect(earliestDeadline([approval("a")])).toBeUndefined();
    expect(earliestDeadline([approval("a", "not a date")])).toBeUndefined();
    expect(earliestDeadline([])).toBeUndefined();
  });

  it("reads a deadline, a summary and a preview from the agent's own entries", () => {
    const state = {
      pendingApprovals: [
        { id: "a1", status: "pending", toolName: "t", args: {}, expiresAt: "2026-02-03T04:05:06.000Z", metadata: { prompt: "Sure?", summary: "does a thing" } },
        { id: "a2", status: "pending", toolName: "t", metadata: { expiresAt: 1_800_000_000_000 } },
        { id: "a3", status: "pending", toolName: "t", expiresAt: "garbage" },
        { id: "a4", status: "approved", toolName: "t" },
      ],
      pendingUserQuestions: [
        {
          id: "q1",
          status: "pending",
          expiresAt: new Date("2026-03-01T00:00:00.000Z"),
          questions: [{ question: "Which?", options: [{ label: "A", preview: "code" }, { label: "B", preview: "" }] }],
        },
      ],
    };
    const [a1, a2, a3, q1] = detectPendingActions({ state });
    expect(a1).toMatchObject({ id: "a1", title: "Sure?", summary: "does a thing", expiresAt: "2026-02-03T04:05:06.000Z" });
    expect(a2!.expiresAt).toBe(new Date(1_800_000_000_000).toISOString());
    expect(a3!.expiresAt).toBeUndefined();
    expect(q1).toMatchObject({ id: "q1", type: "user_question", expiresAt: "2026-03-01T00:00:00.000Z" });
    expect((q1 as { questions: Array<{ options: Array<Record<string, unknown>> }> }).questions[0]!.options).toEqual([
      { label: "A", value: undefined, description: undefined, preview: "code" },
      { label: "B", value: undefined, description: undefined },
    ]);
  });
});

describe("the record on the paused message", () => {
  const actions: PendingAction[] = [
    { id: "a1", type: "tool_approval", toolName: "t", args: { x: 1 }, expiresAt: "2026-01-01T00:00:00.000Z" },
    { id: "q1", type: "user_question", questions: [{ question: "Which?" }] },
  ];
  const at = new Date("2026-01-01T00:01:00.000Z");

  it("starts every action as pending", () => {
    expect(openSnapshot(actions).map((a) => a.status)).toEqual(["pending", "pending"]);
    expect(openSnapshot(actions)[0]).toMatchObject({ id: "a1", toolName: "t", args: { x: 1 } });
  });

  it("settles the ones it is told about, keeps what was asked, and drops the waiting flag when none is open", () => {
    const metadata = { requiresAction: true, status: "requires_action", stopReason: "requires_action", pendingActions: openSnapshot(actions) };
    const one = settleSnapshot(metadata, new Map([["a1", { status: "resolved" as const, resolution: { type: "tool_approval" as const, decision: "allow" as const }, resolvedBy: "alice", resolvedAt: at }]]))!;
    expect(one.requiresAction).toBe(true);
    expect((one.pendingActions as any[])[0]).toEqual({
      id: "a1",
      type: "tool_approval",
      toolName: "t",
      args: { x: 1 },
      expiresAt: "2026-01-01T00:00:00.000Z",
      status: "resolved",
      resolution: { type: "tool_approval", decision: "allow" },
      resolvedBy: "alice",
      resolvedAt: at.toISOString(),
    });
    expect((one.pendingActions as any[])[1].status).toBe("pending");
    expect(one.status).toBe("requires_action");

    const both = settleSnapshot(one, new Map([["q1", { status: "cancelled" as const, resolvedBy: "system", resolvedAt: at }]]))!;
    expect(both.requiresAction).toBeUndefined();
    expect((both.pendingActions as any[]).map((a) => a.status)).toEqual(["resolved", "cancelled"]);
    expect((both.pendingActions as any[])[1]).not.toHaveProperty("resolution");
    // settling again replaces the record
    const again = settleSnapshot(both, new Map([["a1", { status: "expired" as const, resolvedBy: "system:timeout", resolvedAt: at }]]))!;
    expect((again.pendingActions as any[])[0]).toMatchObject({ status: "expired", resolvedBy: "system:timeout" });
    expect((again.pendingActions as any[])[0]).not.toHaveProperty("resolution");
  });

  it("has nothing to say about a message that does not carry the action", () => {
    expect(settleSnapshot({ pendingActions: openSnapshot(actions) }, new Map([["zzz", { status: "cancelled" as const, resolvedBy: "x", resolvedAt: at }]]))).toBeUndefined();
    expect(settleSnapshot({}, new Map([["a1", { status: "cancelled" as const, resolvedBy: "x", resolvedAt: at }]]))).toBeUndefined();
    expect(settleSnapshot(undefined, new Map())).toBeUndefined();
  });
});

describe("the stores a conversation keeps for the server", () => {
  it("keeps the budget store and the HITL store out of what clients see, and does not let a handler's state erase them", () => {
    const state = writeBudget(writeHitl({ visible: 1 }, { allowedTools: ["t"] }), { budget: { maxCostUsd: 2, onReach: "pause" }, spentUsd: 0.5 });
    expect(readBudget(state)).toEqual({ budget: { maxCostUsd: 2, onReach: "pause" }, spentUsd: 0.5 });
    expect(publicState(state)).toEqual({ visible: 1 });
    expect(publicState(writeBudget({}, { spentUsd: 1 }))).toBeUndefined();
    const merged = withHiddenStores({ handler: "state", __agentServerBudget: { spentUsd: 99 } }, state);
    expect(merged.handler).toBe("state");
    expect(readBudget(merged)).toEqual({ budget: { maxCostUsd: 2, onReach: "pause" }, spentUsd: 0.5 });
    expect((merged.__agentServerHitl as any).allowedTools).toEqual(["t"]);
    // nothing to keep: nothing of theirs stays either
    expect(withHiddenStores({ a: 1, __agentServerHitl: { x: 1 } }, { b: 2 })).toEqual({ a: 1 });
  });

  it("writes no budget store for a conversation that has no budget and has spent nothing", () => {
    expect(writeBudget({ a: 1 }, undefined)).toEqual({ a: 1 });
    expect(writeBudget({ a: 1 }, { spentUsd: 0 })).toEqual({ a: 1 });
    expect(writeBudget({ a: 1 }, { budget: null })).toEqual({ a: 1, __agentServerBudget: { budget: null } });
  });
});
