/**
 * Human-in-the-loop helpers: pending-action detection for agent-sdk agents and
 * the bookkeeping that lets a paused turn survive a reload / process restart.
 *
 * Pending actions live in `Conversation.state` under {@link HITL_STATE_KEY}
 * (never in `metadata`, which clients can PATCH). The paused agent-sdk state
 * is stored next to them and is stripped from every conversation the API
 * returns.
 */

import type {
  ActionResolution,
  ActionSnapshot,
  PendingAction,
  SessionBudget,
  UserQuestion,
} from "./types.js";

export const HITL_STATE_KEY = "__agentServerHitl";
/** Where the conversation's spend limit and running total live (hidden from clients like the HITL store). */
export const BUDGET_STATE_KEY = "__agentServerBudget";

/** Most "remembered" auto-approvals chained within one turn before we hand control back. */
const MAX_AUTO_APPROVALS = 20;

export interface HitlPending {
  /** The actions still open. Each carries its `expiresAt` (ISO), when it has one. */
  actions: PendingAction[];
  /** The assistant message the actions belong to. */
  messageId: string;
  /** Resumable agent-sdk state (SDK agents only), with the decisions taken so far applied. */
  sdkState?: unknown;
  /** What happens to an action nobody answered in time; fixed when the pause is taken. */
  onTimeout?: "deny" | "cancel";
}

export interface HitlStore {
  pending?: HitlPending;
  /** Tools the user chose not to be asked about again in this conversation. */
  allowedTools?: string[];
  /**
   * A turn the conversation's budget stopped in the middle: the agent-sdk state to carry on from, once the budget
   * allows (`POST /conversations/:id/continue`).
   */
  budgetPause?: { sdkState: unknown; messageId: string };
}

/** The conversation's spend limit and running total. */
export interface BudgetStore {
  /** `null`: the conversation has no limit although its agent has a default (removed on purpose). Absent: use the agent's. */
  budget?: SessionBudget | null;
  /** Total cost of the conversation's turns so far, USD. */
  spentUsd?: number;
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
  if (store && (store.pending || store.allowedTools?.length || store.budgetPause)) next[HITL_STATE_KEY] = store;
  return next;
}

export function readBudget(state: Record<string, unknown> | undefined): BudgetStore | undefined {
  const raw = state?.[BUDGET_STATE_KEY];
  return isObject(raw) ? (raw as BudgetStore) : undefined;
}

/** Returns `state` with the budget store replaced (or removed when it says nothing). */
export function writeBudget(
  state: Record<string, unknown> | undefined,
  store: BudgetStore | undefined
): Record<string, unknown> {
  const next = { ...(state ?? {}) };
  delete next[BUDGET_STATE_KEY];
  if (store && (store.budget !== undefined || (store.spentUsd ?? 0) > 0)) next[BUDGET_STATE_KEY] = store;
  return next;
}

/** `state` as clients may see it: without the internal HITL and budget stores. */
export function publicState(state: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!state || !(HITL_STATE_KEY in state || BUDGET_STATE_KEY in state)) return state;
  const { [HITL_STATE_KEY]: _hitl, [BUDGET_STATE_KEY]: _budget, ...rest } = state;
  return Object.keys(rest).length > 0 ? rest : undefined;
}

/** The internal stores of `from`, put onto `to` (a state a handler returned must not lose them). */
export function withHiddenStores(
  to: Record<string, unknown>,
  from: Record<string, unknown> | undefined
): Record<string, unknown> {
  const next = { ...to };
  for (const key of [HITL_STATE_KEY, BUDGET_STATE_KEY]) {
    delete next[key];
    if (from && key in from) next[key] = from[key];
  }
  return next;
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

/** An ISO timestamp from whatever an agent put in `expiresAt` (a Date, a number of ms, a string), or undefined. */
function isoOf(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const date = value instanceof Date ? value : new Date(typeof value === "number" || typeof value === "string" ? value : NaN);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

/** Pending approvals / questions of an `invoke` result, as protocol actions. */
export function detectPendingActions(result: { state?: any } | undefined): PendingAction[] {
  const state = result?.state;
  if (!isObject(state)) return [];
  const out: PendingAction[] = [];

  for (const entry of Array.isArray(state.pendingApprovals) ? state.pendingApprovals : []) {
    if (!isObject(entry) || entry.status !== "pending" || typeof entry.id !== "string") continue;
    const meta = isObject(entry.metadata) ? entry.metadata : undefined;
    const prompt = meta?.prompt;
    const summary = meta?.summary;
    const expiresAt = isoOf(entry.expiresAt ?? meta?.expiresAt);
    out.push({
      id: entry.id,
      type: "tool_approval",
      toolName: String(entry.toolName ?? ""),
      toolCallId: typeof entry.toolCallId === "string" ? entry.toolCallId : undefined,
      title: typeof prompt === "string" ? prompt : undefined,
      summary: typeof summary === "string" && summary !== "" ? summary : undefined,
      args: isObject(entry.args) ? entry.args : undefined,
      ...(expiresAt ? { expiresAt } : {}),
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
        ? q.options.map((o: any) => ({
            label: o.label,
            value: o.value,
            description: o.description,
            ...(typeof o.preview === "string" && o.preview !== "" ? { preview: o.preview } : {}),
          }))
        : undefined,
    }));
    const expiresAt = isoOf(entry.expiresAt ?? (isObject(entry.metadata) ? entry.metadata.expiresAt : undefined));
    out.push({
      id: entry.id,
      type: "user_question",
      questions,
      allowFreeText: typeof entry.allowFreeText === "boolean" ? entry.allowFreeText : undefined,
      ...(expiresAt ? { expiresAt } : {}),
    });
  }

  return out;
}

// ----------------------------------------------------------------------------
// Deadlines
// ----------------------------------------------------------------------------

/**
 * Gives every action that has no deadline of its own `now + timeoutMinutes`. `timeoutMinutes` 0 (or less) means
 * they never lapse. Returns new objects.
 */
export function stampDeadlines(actions: PendingAction[], timeoutMinutes: number, now: Date = new Date()): PendingAction[] {
  const fallback = timeoutMinutes > 0 ? new Date(now.getTime() + timeoutMinutes * 60_000).toISOString() : undefined;
  let changed = false;
  const out = actions.map((action) => {
    // A deadline the agent gave is kept (as an ISO time); one that is no time at all counts as none
    const own = isoOf(action.expiresAt);
    const expiresAt = own ?? fallback;
    if (expiresAt === action.expiresAt) return action;
    changed = true;
    if (expiresAt === undefined) {
      const { expiresAt: _unusable, ...rest } = action;
      return rest as PendingAction;
    }
    return { ...action, expiresAt };
  });
  return changed ? out : actions;
}

export const isExpired = (action: Pick<PendingAction, "expiresAt">, now: Date = new Date()): boolean =>
  !!action.expiresAt && new Date(action.expiresAt).getTime() <= now.getTime();

/** The earliest moment one of `actions` lapses, or undefined when none does. */
export function earliestDeadline(actions: PendingAction[]): Date | undefined {
  let earliest: number | undefined;
  for (const action of actions) {
    const at = action.expiresAt ? new Date(action.expiresAt).getTime() : NaN;
    if (Number.isFinite(at) && (earliest === undefined || at < earliest)) earliest = at;
  }
  return earliest === undefined ? undefined : new Date(earliest);
}

// ----------------------------------------------------------------------------
// The record on the paused message
// ----------------------------------------------------------------------------

/** The actions of a pause as the paused assistant message carries them (`metadata.pendingActions`), all still open. */
export function openSnapshot(actions: PendingAction[]): ActionSnapshot[] {
  return actions.map((action) => ({ ...action, status: "pending" as const }));
}

export interface SettledAction {
  status: Exclude<ActionSnapshot["status"], "pending">;
  resolution?: ActionResolution;
  resolvedBy: string;
  resolvedAt: Date;
}

/**
 * `metadata` of a paused message with the given actions settled: their snapshot entry gets the status, the answer, who gave it and
 * when. Entries it does not name are left alone. Returns `undefined` when none of the actions is on the message.
 */
export function settleSnapshot(
  metadata: Record<string, unknown> | undefined,
  settled: Map<string, SettledAction>
): Record<string, unknown> | undefined {
  const entries = Array.isArray(metadata?.pendingActions) ? (metadata!.pendingActions as ActionSnapshot[]) : undefined;
  if (!entries || !entries.some((entry) => settled.has(entry.id))) return undefined;
  const pendingActions = entries.map((entry) => {
    const done = settled.get(entry.id);
    if (!done) return entry;
    const { resolution: _old, resolvedBy: _by, resolvedAt: _at, ...asked } = entry as ActionSnapshot;
    return {
      ...asked,
      status: done.status,
      ...(done.resolution ? { resolution: done.resolution } : {}),
      resolvedBy: done.resolvedBy,
      resolvedAt: done.resolvedAt.toISOString(),
    } as ActionSnapshot;
  });
  // The message stops saying it waits once nothing on it is open
  const stillOpen = pendingActions.some((entry) => entry.status === "pending");
  const { requiresAction: _waiting, ...rest } = metadata!;
  return { ...rest, ...(stillOpen ? { requiresAction: true } : {}), pendingActions };
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
 * chose to remember, so "don't ask again" works without a round trip. `onAutoApproved` hears about each one.
 */
export async function runSdkTurn(
  agent: HitlSdkAgent,
  input: unknown,
  config: unknown,
  allowedTools: ReadonlySet<string>,
  onAutoApproved?: (action: PendingAction) => void
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
      onAutoApproved?.(a);
    }
    result = await agent.invoke(next, config);
    pending = detectPendingActions(result);
  }
  return { result, pending };
}
