/**
 * Agent-sdk look-alikes for the approval, expiry and budget tests. They keep the usage ledger the way the real SDK does
 * (`{ perRequest, totals }`, cumulative over the life of a state, so a resumed run hands back the usage of its earlier
 * legs too) and honour `limits.maxCostUsd` the way it does (checked before each model call, against the whole ledger).
 */

import type { PricingFn } from "../src/index.js";

export interface Ledger {
  perRequest: Array<{ id: string; modelName: string; usage: Record<string, unknown>; timestamp: string; turn: number; cachedInput?: number }>;
  totals: Record<string, { input: number; output: number; total: number; cachedInput: number }>;
}

/** The ledger after one more model call (never mutates the one it is given). */
export function withCall(ledger: Ledger | undefined, model: string, input: number, output: number, cached = 0): Ledger {
  const base: Ledger = ledger ? structuredClone(ledger) : { perRequest: [], totals: {} };
  base.perRequest.push({
    id: `req_${base.perRequest.length + 1}`,
    modelName: model,
    usage: { prompt_tokens: input, completion_tokens: output, total_tokens: input + output, prompt_tokens_details: { cached_tokens: cached } },
    timestamp: new Date().toISOString(),
    turn: base.perRequest.length + 1,
    cachedInput: cached,
  });
  const before = base.totals[model] ?? { input: 0, output: 0, total: 0, cachedInput: 0 };
  base.totals[model] = {
    input: before.input + input,
    output: before.output + output,
    total: before.total + input + output,
    cachedInput: before.cachedInput + cached,
  };
  return base;
}

/**
 * What agent-sdk really does (`recordUsage`): adds the call to the ledger it is handed IN PLACE and returns it. Stubs use
 * this, so a server that keeps a reference to the ledger it passed in sees it grow - as it would with the real SDK.
 */
export function recordCall(ledger: Ledger | undefined, model: string, input: number, output: number, cached = 0): Ledger {
  const target: Ledger = ledger ?? { perRequest: [], totals: {} };
  const added = withCall(undefined, model, input, output, cached);
  target.perRequest.push({ ...added.perRequest[0]!, id: `req_${target.perRequest.length + 1}`, turn: target.perRequest.length + 1 });
  const before = target.totals[model] ?? { input: 0, output: 0, total: 0, cachedInput: 0 };
  target.totals[model] = {
    input: before.input + input,
    output: before.output + output,
    total: before.total + input + output,
    cachedInput: before.cachedInput + cached,
  };
  return target;
}

/** USD per token used by the tests: model `m1` costs $0.001 per input and $0.002 per output token. */
export const testPricing: PricingFn = (model) =>
  model === "m1"
    ? { inputPerToken: 0.001, outputPerToken: 0.002 }
    : model === "cached-model"
      ? { inputPerToken: 0.001, outputPerToken: 0.002, cachedInputPerToken: 0.0001 }
      : undefined;

/** What the ledger costs at {@link testPricing} (a call of 100 in / 50 out is $0.20). */
export function ledgerCost(ledger: Ledger | undefined): number {
  let cost = 0;
  for (const [model, used] of Object.entries(ledger?.totals ?? {})) {
    const price = testPricing(model);
    if (price) cost += (used.input - used.cachedInput) * price.inputPerToken + used.cachedInput * (price.cachedInputPerToken ?? price.inputPerToken) + used.output * price.outputPerToken;
  }
  return Math.round(cost * 1e8) / 1e8;
}

// ----------------------------------------------------------------------------
// An agent that pauses for approvals / a question
// ----------------------------------------------------------------------------

export interface PausingOptions {
  /** Approvals per pause (default 1): ids ap1..apN. */
  approvals?: number;
  /** Pause with a question (id q1) instead. */
  question?: boolean | { preview?: string };
  toolName?: string;
  args?: Record<string, unknown>;
  /** `expiresAt` of the agent's own entries. */
  expiresAt?: () => string | undefined;
  /** `metadata.summary` of the approvals. */
  summary?: string;
  /** Usage of the leg that pauses, and of the leg that finishes. */
  pauseCall?: { model?: string; input: number; output: number; cached?: number };
  finishCall?: { model?: string; input: number; output: number; cached?: number };
  /** Pause again on the first resume (the continuation asks again). */
  pauseTwice?: boolean;
  /** Tools the agent declares (`__runtime.tools`), for the checks on edited arguments and for remembering. */
  tools?: Array<Record<string, unknown>>;
}

export function pausingStub(options: PausingOptions = {}) {
  const calls: Array<{ input: any; config: any }> = [];
  const count = options.approvals ?? 1;
  let pauses = 0;

  /** The agent's own `expiresAt` for one entry (asked once per entry). */
  const deadline = (): { expiresAt?: string } => {
    const at = options.expiresAt?.();
    return at ? { expiresAt: at } : {};
  };

  const approvals = (round: number) =>
    options.question
      ? []
      : Array.from({ length: count }, (_, i) => ({
          id: round === 1 ? `ap${i + 1}` : `ap${round}_${i + 1}`,
          toolCallId: `call${i + 1}`,
          toolName: options.toolName ?? "deploy",
          args: { ...(options.args ?? { version: "1.0" }) },
          status: "pending",
          requestedAt: new Date().toISOString(),
          metadata: { prompt: "Deploy 1.0?", ...(options.summary ? { summary: options.summary } : {}) },
          ...deadline(),
        }));
  const questions = (round: number) =>
    options.question
      ? [
          {
            id: round === 1 ? "q1" : `q${round}`,
            toolCallId: "qcall",
            toolName: "ask_user_question",
            status: "pending",
            requestedAt: new Date().toISOString(),
            allowFreeText: true,
            ...deadline(),
            questions: [
              {
                question: "Which env?",
                header: "Env",
                required: true,
                options: [
                  { label: "Staging", value: "stg", ...(typeof options.question === "object" && options.question.preview ? { preview: options.question.preview } : {}) },
                  { label: "Production", value: "prod" },
                ],
              },
            ],
          },
        ]
      : [];

  const pausedState = (input: any, ledger: Ledger | undefined) => {
    pauses += 1;
    return {
      messages: [...(input.messages ?? []), { role: "assistant", content: "" }],
      pendingApprovals: approvals(pauses),
      pendingUserQuestions: questions(pauses),
      ctx: options.question ? { __awaitingUserQuestion: {} } : { __awaitingApproval: { approvalId: "ap1" } },
      ...(ledger ? { usage: ledger } : {}),
    };
  };

  const agent = {
    calls,
    __runtime: { tools: options.tools ?? [] },
    invoke: async (input: any, config?: any) => {
      calls.push({ input: structuredClone({ ...input, agent: undefined }), config });
      const entries = [...(input.pendingApprovals ?? []), ...(input.pendingUserQuestions ?? [])];
      const open = entries.some((e: any) => e.status === "pending");
      const decided = entries.some((e: any) => e.status !== "pending");

      if (entries.length === 0 || open) {
        // a fresh turn pauses; a state that still has an open request stays paused
        if (open) {
          const state = { ...input, ctx: input.ctx };
          return { content: "", messages: state.messages, metadata: { usage: input.usage }, state };
        }
        const call = options.pauseCall;
        const ledger = call ? recordCall(input.usage, call.model ?? "m1", call.input, call.output, call.cached) : input.usage;
        const state = pausedState(input, ledger);
        return { content: "", messages: state.messages, metadata: { usage: ledger }, state };
      }

      if (decided && options.pauseTwice && pauses < 2) {
        const state = pausedState(input, input.usage);
        return { content: "", messages: state.messages, metadata: { usage: input.usage }, state };
      }

      // every request is answered: the tool runs
      const approved = (input.pendingApprovals ?? []).filter((a: any) => a.status === "approved");
      const rejected = (input.pendingApprovals ?? []).filter((a: any) => a.status === "rejected");
      const answered = (input.pendingUserQuestions ?? []).find((q: any) => q.status === "answered");
      const skipped = (input.pendingUserQuestions ?? []).find((q: any) => q.status === "cancelled");
      config?.onEvent?.({ type: "tool_call", phase: "start", name: "deploy", id: "call1", args: { version: "1.0" } });
      config?.onEvent?.({ type: "tool_call", phase: "success", name: "deploy", id: "call1", result: "ok" });
      const verdict = rejected.length > 0
        ? "denied"
        : skipped
          ? "skipped"
          : answered
            ? `answers:${JSON.stringify(answered.answers)}`
            : approved.some((a: any) => a.approvedArgs)
              ? `deployed:${JSON.stringify(approved.find((a: any) => a.approvedArgs).approvedArgs)}`
              : "deployed";
      const call = options.finishCall;
      const ledger = call ? recordCall(input.usage, call.model ?? "m1", call.input, call.output, call.cached) : input.usage;
      config?.onStream?.({ text: verdict });
      return {
        content: verdict,
        messages: [],
        metadata: { usage: ledger },
        state: { messages: [], pendingApprovals: [], pendingUserQuestions: [], ...(ledger ? { usage: ledger } : {}) },
      };
    },
    resolveToolApproval: (state: any, r: any) => {
      const list = (state.pendingApprovals ?? []).map((a: any) => ({ ...a }));
      const entry = list.find((a: any) => a.id === r.id);
      if (!entry) throw new Error(`Pending approval not found for id: ${r.id}`);
      entry.status = r.approved ? "approved" : "rejected";
      entry.approvedArgs = r.approved ? r.approvedArgs : undefined;
      entry.decidedBy = r.decidedBy;
      entry.comment = r.comment;
      const ctx = { ...(state.ctx ?? {}) };
      if (!list.some((a: any) => a.status === "pending")) delete ctx.__awaitingApproval;
      return { ...state, pendingApprovals: list, ctx };
    },
    resolveUserQuestion: (state: any, r: any) => {
      const list = (state.pendingUserQuestions ?? []).map((q: any) => ({ ...q }));
      const entry = list.find((q: any) => q.id === r.id);
      if (!entry) throw new Error(`Pending user question not found for id: ${r.id}`);
      if (!r.cancelled && !r.answers?.["Which env?"]) throw new Error('Missing answer for required question: "Which env?".');
      entry.status = r.cancelled ? "cancelled" : "answered";
      entry.answers = r.answers;
      const ctx = { ...(state.ctx ?? {}) };
      delete ctx.__awaitingUserQuestion;
      return { ...state, pendingUserQuestions: list, ctx };
    },
  };
  return agent;
}

// ----------------------------------------------------------------------------
// An agent that works in several steps and stops on a cost limit
// ----------------------------------------------------------------------------

export interface SteppingOptions {
  /** Model calls the turn makes when nothing stops it. */
  steps: number;
  model?: string;
  input?: number;
  output?: number;
  /** What the stopped turn has said so far. */
  partial?: string;
}

/** Makes `steps` model calls, checking `limits.maxCostUsd` against the whole ledger before each one, like agent-sdk. */
export function steppingStub(options: SteppingOptions) {
  const calls: Array<{ input: any; config: any }> = [];
  const model = options.model ?? "m1";
  const agent = {
    calls,
    __runtime: { tools: [] as unknown[] },
    invoke: async (input: any, config?: any) => {
      calls.push({ input: structuredClone(input), config });
      // a state to carry on from has an iteration; a fresh turn has messages only
      let state: any = typeof input.iteration === "number" ? structuredClone(input) : { messages: [...(input.messages ?? [])], iteration: 0, ctx: {} };
      const cap = config?.limits?.maxCostUsd;
      while (state.iteration < options.steps) {
        if (config?.cancellationToken?.aborted) {
          state.ctx = { ...(state.ctx ?? {}), __cancelled: { stage: "model", reason: "aborted" } };
          return { content: state.partial ?? "", messages: state.messages, metadata: { usage: state.usage }, state };
        }
        if (cap && ledgerCost(state.usage) > cap) {
          state.ctx = { ...(state.ctx ?? {}), __limitBreached: `maxCostUsd ($${cap}) exceeded (actual: $${ledgerCost(state.usage).toFixed(4)})` };
          state.partial = options.partial ?? `worked for ${state.iteration} steps`;
          return { content: state.partial, messages: state.messages, metadata: { usage: state.usage }, state };
        }
        state.usage = recordCall(state.usage, model, options.input ?? 100, options.output ?? 50);
        state.iteration += 1;
        config?.onStream?.({ text: `step${state.iteration} ` });
      }
      state.partial = undefined;
      const content = `finished after ${state.iteration} steps`;
      return { content, messages: state.messages, metadata: { usage: state.usage }, state };
    },
    resolveToolApproval: (state: any) => state,
    resolveUserQuestion: (state: any) => state,
  };
  return agent;
}
