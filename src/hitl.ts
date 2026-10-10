/**
 * Human-in-the-loop helpers: pending-action detection for agent-sdk agents and
 * the bookkeeping that lets a paused turn survive a reload / process restart.
 *
 * Pending actions live in `Conversation.state` under {@link HITL_STATE_KEY}
 * (never in `metadata`, which clients can PATCH). The paused agent-sdk state
 * is stored next to them and is stripped from every conversation the API
 * returns.
 */

import type { PendingAction, ActionResolution, UserQuestion } from "./types.js";

export const HITL_STATE_KEY = "__agentServerHitl";

/** Most "remembered" auto-approvals chained within one turn before we hand control back. */
const MAX_AUTO_APPROVALS = 20;

export interface HitlPending {
  actions: PendingAction[];
  /** The assistant message the actions belong to. */
  messageId: string;
  /** Resumable agent-sdk state (SDK agents only). */
  sdkState?: unknown;
}

export interface HitlStore {
  pending?: HitlPending;
  /** Tools the user chose not to be asked about again in this conversation. */
  allowedTools?: string[];
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

export function readHitl(state: Record<string, unknown> | undefined): HitlStore | undefined {
  const raw = state?.[HITL_STATE_KEY];
  return isObject(raw) ? (raw as HitlStore) : undefined;
}

/** Returns `state` with the HITL store replaced (or removed when empty). */
export function writeHitl(
  state: Record<string, unknown> | undefined,
  store: HitlStore | undefined
): Record<string, unknown> {
  const next = { ...(state ?? {}) };
  delete next[HITL_STATE_KEY];
  if (store && (store.pending || store.allowedTools?.length)) next[HITL_STATE_KEY] = store;
  return next;
}

/** `state` as clients may see it: without the internal HITL store. */
export function publicState(state: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!state || !(HITL_STATE_KEY in state)) return state;
  const { [HITL_STATE_KEY]: _hidden, ...rest } = state;
  return Object.keys(rest).length > 0 ? rest : undefined;
}

// ----------------------------------------------------------------------------
// agent-sdk bridge
// ----------------------------------------------------------------------------

/** The slice of an agent-sdk agent the pause/resolve flow relies on. */
export interface HitlSdkAgent {
  invoke: (
    input: any,
    config?: any
  ) => Promise<{ content: string; metadata?: { usage?: unknown }; state?: any }>;
  resolveToolApproval?: (state: any, resolution: any) => any;
  resolveUserQuestion?: (state: any, resolution: any) => any;
}

export const supportsSdkPause = (agent: unknown): agent is HitlSdkAgent =>
  !!agent &&
  typeof (agent as HitlSdkAgent).resolveToolApproval === "function" &&
  typeof (agent as HitlSdkAgent).resolveUserQuestion === "function";

/** Pending approvals / questions of an `invoke` result, as protocol actions. */
export function detectPendingActions(result: { state?: any } | undefined): PendingAction[] {
  const state = result?.state;
  if (!isObject(state)) return [];
  const out: PendingAction[] = [];

  for (const entry of Array.isArray(state.pendingApprovals) ? state.pendingApprovals : []) {
    if (!isObject(entry) || entry.status !== "pending" || typeof entry.id !== "string") continue;
    const prompt = isObject(entry.metadata) ? entry.metadata.prompt : undefined;
    out.push({
      id: entry.id,
      type: "tool_approval",
      toolName: String(entry.toolName ?? ""),
      toolCallId: typeof entry.toolCallId === "string" ? entry.toolCallId : undefined,
      title: typeof prompt === "string" ? prompt : undefined,
      args: isObject(entry.args) ? entry.args : undefined,
    });
  }

  for (const entry of Array.isArray(state.pendingUserQuestions) ? state.pendingUserQuestions : []) {
    if (!isObject(entry) || entry.status !== "pending" || typeof entry.id !== "string") continue;
    const questions: UserQuestion[] = (Array.isArray(entry.questions) ? entry.questions : []).map((q: any) => ({
      question: String(q.question ?? ""),
      header: q.header,
      multiSelect: q.multiSelect,
      placeholder: q.placeholder,
      required: q.required,
      options: Array.isArray(q.options)
        ? q.options.map((o: any) => ({ label: o.label, value: o.value, description: o.description }))
        : undefined,
    }));
    out.push({
      id: entry.id,
      type: "user_question",
      questions,
      allowFreeText: typeof entry.allowFreeText === "boolean" ? entry.allowFreeText : undefined,
    });
  }

  return out;
}

/**
 * ctx keys that hold live objects (closures, signals, plugin hosts) or that
 * describe the run that produced a snapshot rather than the one resuming it.
 * Mirrors agent-sdk's snapshot sanitising; the SDK rebuilds all of them per invoke.
 */
const NON_PORTABLE_CTX_KEYS = new Set([
  "__onEvent",
  "__onProgress",
  "__onStream",
  "__traceSession",
  "__paused",
  "__cancellationToken",
  "__abortSignal",
  "__contextPilot",
  "__plugins",
  "__applySystemPromptContribution",
  "__pluginState",
  "__pluginRunStarted",
  "__pluginRunEnded",
  "__restoredFromSnapshot",
  "__guardrailBlocked",
]);

/**
 * A paused SDK state as plain JSON: without `agent` (the live runtime - model
 * and tool functions - which the SDK re-attaches on invoke) and without live ctx entries.
 */
export function portableState(state: unknown): unknown {
  if (!isObject(state)) return state;
  const { agent: _runtime, ctx, ...rest } = state as Record<string, unknown>;
  const cleanCtx = isObject(ctx)
    ? Object.fromEntries(Object.entries(ctx).filter(([key]) => !NON_PORTABLE_CTX_KEYS.has(key)))
    : undefined;
  return jsonSafe({ ...rest, ...(cleanCtx && { ctx: cleanCtx }) });
}

/** Deep-copies through JSON so the state can be stored (functions / cycles are dropped). */
export function jsonSafe<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * Maps `{ "<question text>": "value" | ["v1", ...] }` to the SDK's answer shape.
 * Values matching an option (by value or label) are selections; anything else
 * is a free-text answer.
 */
export function toSdkAnswers(
  questions: UserQuestion[],
  answers: Record<string, string | string[]> | undefined
): Record<string, { values: string[]; freeText?: string }> {
  const out: Record<string, { values: string[]; freeText?: string }> = {};
  for (const q of questions) {
    const raw = answers?.[q.question] ?? (q.header ? answers?.[q.header] : undefined);
    if (raw === undefined || raw === null) continue;
    const given = (Array.isArray(raw) ? raw : [raw]).filter((v) => typeof v === "string" && v.trim() !== "");
    if (given.length === 0) continue;

    const byLabel = new Map<string, string>();
    for (const o of q.options ?? []) {
      byLabel.set(o.value ?? o.label, o.value ?? o.label);
      byLabel.set(o.label, o.value ?? o.label);
    }
    const values: string[] = [];
    const free: string[] = [];
    for (const v of given) {
      const matched = byLabel.get(v);
      if (matched !== undefined) values.push(matched);
      else free.push(v);
    }
    out[q.question] = { values, ...(free.length ? { freeText: free.join(", ") } : {}) };
  }
  return out;
}

/**
 * Applies a resolution to a paused SDK state (does not resume). Throws the
 * SDK's own error on invalid input (e.g. a missing required answer).
 */
export function applySdkResolution(
  agent: HitlSdkAgent,
  state: unknown,
  action: PendingAction,
  resolution: ActionResolution,
  decidedBy?: string
): unknown {
  if (action.type === "tool_approval" && resolution.type === "tool_approval") {
    return agent.resolveToolApproval!(state, {
      id: action.id,
      approved: resolution.decision === "allow",
      ...(resolution.approvedArgs ? { approvedArgs: resolution.approvedArgs } : {}),
      decidedBy,
      comment: resolution.comment,
    });
  }
  if (action.type === "user_question" && resolution.type === "user_question") {
    return agent.resolveUserQuestion!(state, {
      id: action.id,
      answers: toSdkAnswers(action.questions, resolution.answers),
      answeredBy: decidedBy,
      cancelled: resolution.cancelled === true,
    });
  }
  throw new Error(`Resolution type "${resolution.type}" does not match action type "${action.type}"`);
}

/**
 * Invokes the agent, auto-approving pauses that only ask about tools the user
 * chose to remember, so "don't ask again" works without a round trip.
 */
export async function runSdkTurn(
  agent: HitlSdkAgent,
  input: unknown,
  config: unknown,
  allowedTools: ReadonlySet<string>
): Promise<{ result: Awaited<ReturnType<HitlSdkAgent["invoke"]>>; pending: PendingAction[] }> {
  const cancelled = () => (config as { cancellationToken?: { aborted?: boolean } } | undefined)?.cancellationToken?.aborted === true;
  let result = await agent.invoke(input, config);
  let pending = detectPendingActions(result);
  for (
    let i = 0;
    i < MAX_AUTO_APPROVALS &&
    pending.length > 0 &&
    !cancelled() &&
    supportsSdkPause(agent) &&
    pending.every((a) => a.type === "tool_approval" && allowedTools.has(a.toolName));
    i++
  ) {
    let next = result.state;
    for (const a of pending) {
      next = agent.resolveToolApproval!(next, { id: a.id, approved: true, decidedBy: "remembered" });
    }
    result = await agent.invoke(next, config);
    pending = detectPendingActions(result);
  }
  return { result, pending };
}
