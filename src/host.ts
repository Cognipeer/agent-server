/**
 * Host-backed agents: agents whose work runs in the host's own backend. The host reports what happens with typed
 * events (`io.emit`) and returns a typed result; the server stores the messages, the pending actions, the events and
 * the runtime status itself. This file holds the pure parts - checking what a host reports - so a malformed event or
 * result is refused at the boundary instead of ending up in a stored conversation.
 */

import { normalizeUsage } from "./usage.js";
import type {
  AgentRegistration,
  FileAttachment,
  HostAgentDefinition,
  HostEvent,
  MessageStatus,
  PendingAction,
  PricingFn,
  StopReason,
  UsageInfo,
  UserQuestion,
} from "./types.js";

export const STOP_REASONS: readonly StopReason[] = [
  "end_turn",
  "requires_action",
  "cancelled",
  "max_turns",
  "limit",
  "budget_reached",
  "error",
];

export const MESSAGE_STATUSES: readonly MessageStatus[] = ["completed", "requires_action", "incomplete", "cancelled"];

const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

const isText = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";

const optionalText = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);

// ----------------------------------------------------------------------------
// Registration
// ----------------------------------------------------------------------------

/**
 * Builds the registration of a host agent. `registerHostAgent` uses it; a host that resolves its agents per request
 * (`config.agents`) returns it from there. Throws when the definition cannot work, at registration and not on the
 * first message.
 */
export function hostAgentRegistration(definition: HostAgentDefinition): AgentRegistration {
  if (!isObject(definition)) throw new Error("A host agent needs a definition: { info, invoke }");
  if (!isObject(definition.info) || !isText(definition.info.id)) {
    throw new Error("A host agent needs info.id");
  }
  const id = definition.info.id;
  if (typeof definition.invoke !== "function") throw new Error(`Host agent "${id}" needs an invoke function`);
  if (definition.resolveAction !== undefined && typeof definition.resolveAction !== "function") {
    throw new Error(`Host agent "${id}": resolveAction has to be a function`);
  }
  if (definition.cancel !== undefined && typeof definition.cancel !== "function") {
    throw new Error(`Host agent "${id}": cancel has to be a function`);
  }
  const { info, files, hitl, budget, pricing } = definition;
  return {
    info: { ...info, name: info.name || id },
    // (called as methods of the definition, so a class instance keeps its `this`)
    host: {
      invoke: (input, io) => definition.invoke(input, io),
      ...(definition.resolveAction && { resolveAction: (input, io) => definition.resolveAction!(input, io) }),
      ...(definition.cancel && { cancel: (input) => definition.cancel!(input) }),
    },
    ...(files && { files }),
    ...(hitl && { hitl }),
    ...(budget !== undefined && { budget }),
    ...(pricing && { pricing }),
  };
}

// ----------------------------------------------------------------------------
// Pending actions
// ----------------------------------------------------------------------------

type Checked<T> = { ok: true; value: T } | { ok: false; message: string };

const fail = (message: string): { ok: false; message: string } => ({ ok: false, message });

function readQuestion(raw: unknown, where: string): Checked<UserQuestion> {
  if (!isObject(raw) || !isText(raw.question)) return fail(`${where}.question must be a non-empty string`);
  let options: UserQuestion["options"];
  if (raw.options !== undefined) {
    if (!Array.isArray(raw.options)) return fail(`${where}.options must be an array`);
    options = [];
    for (const [i, option] of raw.options.entries()) {
      if (!isObject(option) || !isText(option.label)) return fail(`${where}.options[${i}].label must be a non-empty string`);
      options.push({
        label: option.label,
        ...(optionalText(option.value) !== undefined && { value: option.value as string }),
        ...(optionalText(option.description) !== undefined && { description: option.description as string }),
        ...(optionalText(option.preview) !== undefined && { preview: option.preview as string }),
      });
    }
  }
  return {
    ok: true,
    value: {
      question: raw.question,
      ...(optionalText(raw.header) !== undefined && { header: raw.header as string }),
      ...(typeof raw.multiSelect === "boolean" && { multiSelect: raw.multiSelect }),
      ...(optionalText(raw.placeholder) !== undefined && { placeholder: raw.placeholder as string }),
      ...(typeof raw.required === "boolean" && { required: raw.required }),
      ...(options && { options }),
    },
  };
}

function readAction(raw: unknown, where: string): Checked<PendingAction> {
  if (!isObject(raw)) return fail(`${where} must be an object`);
  if (!isText(raw.id)) return fail(`${where}.id must be a non-empty string`);
  let expiresAt: string | undefined;
  if (raw.expiresAt !== undefined) {
    if (typeof raw.expiresAt !== "string" || Number.isNaN(Date.parse(raw.expiresAt))) {
      return fail(`${where}.expiresAt must be an ISO 8601 date string`);
    }
    expiresAt = raw.expiresAt;
  }
  if (raw.type === "tool_approval") {
    if (!isText(raw.toolName)) return fail(`${where}.toolName must be a non-empty string`);
    if (raw.args !== undefined && !isObject(raw.args)) return fail(`${where}.args must be an object`);
    return {
      ok: true,
      value: {
        id: raw.id,
        type: "tool_approval",
        toolName: raw.toolName,
        ...(optionalText(raw.toolCallId) !== undefined && { toolCallId: raw.toolCallId as string }),
        ...(optionalText(raw.title) !== undefined && { title: raw.title as string }),
        ...(optionalText(raw.summary) !== undefined && { summary: raw.summary as string }),
        ...(raw.args !== undefined && { args: raw.args as Record<string, unknown> }),
        ...(expiresAt && { expiresAt }),
      },
    };
  }
  if (raw.type === "user_question") {
    if (!Array.isArray(raw.questions) || raw.questions.length === 0) {
      return fail(`${where}.questions must be a non-empty array`);
    }
    const questions: UserQuestion[] = [];
    for (const [i, question] of raw.questions.entries()) {
      const checked = readQuestion(question, `${where}.questions[${i}]`);
      if (!checked.ok) return checked;
      questions.push(checked.value);
    }
    return {
      ok: true,
      value: {
        id: raw.id,
        type: "user_question",
        questions,
        ...(typeof raw.allowFreeText === "boolean" && { allowFreeText: raw.allowFreeText }),
        ...(expiresAt && { expiresAt }),
      },
    };
  }
  return fail(`${where}.type must be "tool_approval" or "user_question"`);
}

/** The pending actions a host reported, cleaned to the fields the API knows. Ids are unique within the list. */
export function readActions(raw: unknown, where: string): Checked<PendingAction[]> {
  if (!Array.isArray(raw)) return fail(`${where} must be an array`);
  const out: PendingAction[] = [];
  const seen = new Set<string>();
  for (const [i, entry] of raw.entries()) {
    const checked = readAction(entry, `${where}[${i}]`);
    if (!checked.ok) return checked;
    if (seen.has(checked.value.id)) return fail(`${where}[${i}].id "${checked.value.id}" is used twice`);
    seen.add(checked.value.id);
    out.push(checked.value);
  }
  return { ok: true, value: out };
}

// ----------------------------------------------------------------------------
// Events
// ----------------------------------------------------------------------------

/** One `io.emit` event, checked. `message` says what is wrong with one that is not an event. */
export function readHostEvent(raw: unknown): Checked<HostEvent> {
  if (!isObject(raw) || typeof raw.type !== "string") return fail("an event needs a type");
  switch (raw.type) {
    case "text":
      if (typeof raw.text !== "string") return fail("text.text must be a string");
      return { ok: true, value: { type: "text", text: raw.text } };
    case "tool_use":
      if (!isText(raw.id) || !isText(raw.name)) return fail("tool_use needs an id and a name");
      if (raw.args !== undefined && !isObject(raw.args)) return fail("tool_use.args must be an object");
      return {
        ok: true,
        value: { type: "tool_use", id: raw.id, name: raw.name, ...(raw.args !== undefined && { args: raw.args as Record<string, unknown> }) },
      };
    case "tool_result":
      if (!isText(raw.id)) return fail("tool_result needs the id of its tool_use");
      if (raw.error !== undefined && typeof raw.error !== "string") return fail("tool_result.error must be a string");
      return {
        ok: true,
        value: {
          type: "tool_result",
          id: raw.id,
          ...(optionalText(raw.name) !== undefined && { name: raw.name as string }),
          ...(raw.result !== undefined && { result: raw.result }),
          ...(typeof raw.error === "string" && { error: raw.error }),
        },
      };
    case "action_required": {
      const actions = readActions(raw.actions, "action_required.actions");
      return actions.ok ? { ok: true, value: { type: "action_required", actions: actions.value } } : actions;
    }
    case "usage":
      if (!isObject(raw.usage)) return fail("usage.usage must be an object");
      return { ok: true, value: { type: "usage", usage: raw.usage as UsageInfo & { model?: string } } };
    case "stop":
      if (!STOP_REASONS.includes(raw.stopReason as StopReason)) {
        return fail(`stop.stopReason must be one of ${STOP_REASONS.join(", ")}`);
      }
      return {
        ok: true,
        value: { type: "stop", stopReason: raw.stopReason as StopReason, ...(optionalText(raw.detail) !== undefined && { detail: raw.detail as string }) },
      };
    default:
      return fail(`unknown event type "${raw.type}"`);
  }
}

// ----------------------------------------------------------------------------
// Result
// ----------------------------------------------------------------------------

/** What `io.emit` collected during a turn, for the parts of the result that the host may give either way. */
export interface HostCollected {
  actions: PendingAction[];
  usage: Array<UsageInfo & { model?: string }>;
  stopReason?: StopReason;
  detail?: string;
}

export interface HostStep {
  content: string;
  files?: FileAttachment[];
  usage?: UsageInfo;
  pending: PendingAction[];
  metadata?: Record<string, unknown>;
  stopReason?: StopReason;
  status?: MessageStatus;
  detail?: string;
}

/** The error of a host agent that broke the contract: logged, and masked by `maskServerErrors` (it is the host's bug, not the caller's). */
export function invalidHostResult(agentId: string, message: string) {
  return {
    statusCode: 500,
    code: "invalid_host_result",
    message: `Host agent "${agentId}" returned something the server cannot use: ${message}`,
  };
}

function readFiles(raw: unknown): Checked<FileAttachment[]> {
  if (!Array.isArray(raw)) return fail("files must be an array");
  const out: FileAttachment[] = [];
  for (const [i, file] of raw.entries()) {
    if (
      !isObject(file) ||
      !isText(file.id) ||
      !isText(file.name) ||
      !isText(file.mimeType) ||
      typeof file.size !== "number" ||
      !Number.isFinite(file.size)
    ) {
      return fail(`files[${i}] needs id, name, mimeType and size`);
    }
    out.push({ id: file.id, name: file.name, mimeType: file.mimeType, size: file.size });
  }
  return { ok: true, value: out };
}

const sumUsage = (parts: UsageInfo[]): UsageInfo | undefined => {
  if (parts.length === 0) return undefined;
  const total: UsageInfo = {};
  for (const key of ["inputTokens", "outputTokens", "totalTokens", "cachedInputTokens", "costUsd"] as const) {
    const values = parts.map((part) => part[key]).filter((value): value is number => typeof value === "number");
    if (values.length > 0) total[key] = values.reduce((a, b) => a + b, 0);
  }
  return Object.keys(total).length > 0 ? total : undefined;
};

/**
 * The result a host agent returned, checked, merged with what it emitted, and reduced to what the server stores.
 * Throws `invalid_host_result` (500) for a result that is not one.
 */
export function readHostResult(
  agentId: string,
  raw: unknown,
  collected: HostCollected,
  options: { pricing?: PricingFn }
): HostStep {
  if (!isObject(raw)) throw invalidHostResult(agentId, "a turn has to return an object: { content, status, stopReason, pendingActions, usage }");
  if (raw.content !== undefined && typeof raw.content !== "string") throw invalidHostResult(agentId, "content must be a string");
  if (raw.status !== undefined && !MESSAGE_STATUSES.includes(raw.status as MessageStatus)) {
    throw invalidHostResult(agentId, `status must be one of ${MESSAGE_STATUSES.join(", ")}`);
  }
  if (raw.stopReason !== undefined && !STOP_REASONS.includes(raw.stopReason as StopReason)) {
    throw invalidHostResult(agentId, `stopReason must be one of ${STOP_REASONS.join(", ")}`);
  }
  if (raw.metadata !== undefined && !isObject(raw.metadata)) throw invalidHostResult(agentId, "metadata must be an object");
  if (raw.usage !== undefined && !isObject(raw.usage)) throw invalidHostResult(agentId, "usage must be an object");
  if (raw.detail !== undefined && typeof raw.detail !== "string") throw invalidHostResult(agentId, "detail must be a string");

  let pending = collected.actions;
  if (raw.pendingActions !== undefined) {
    const read = readActions(raw.pendingActions, "pendingActions");
    if (!read.ok) throw invalidHostResult(agentId, read.message);
    pending = read.value;
  }
  let files: FileAttachment[] | undefined;
  if (raw.files !== undefined) {
    const read = readFiles(raw.files);
    if (!read.ok) throw invalidHostResult(agentId, read.message);
    files = read.value;
  }

  const usage =
    raw.usage !== undefined
      ? normalizeUsage(raw.usage, { pricing: options.pricing })
      : sumUsage(
          collected.usage
            .map((part) => normalizeUsage(part, { pricing: options.pricing }))
            .filter((part): part is UsageInfo => part !== undefined)
        );

  // "Waiting on a person" with nobody to wait on is not a stop: the turn simply ended
  let stopReason = (raw.stopReason as StopReason | undefined) ?? collected.stopReason;
  if (stopReason === "requires_action" && pending.length === 0) stopReason = undefined;

  return {
    content: (raw.content as string | undefined) ?? "",
    ...(files && files.length > 0 && { files }),
    ...(usage && { usage }),
    pending,
    ...(raw.metadata !== undefined && { metadata: raw.metadata as Record<string, unknown> }),
    stopReason,
    status: raw.status as MessageStatus | undefined,
    detail: (raw.detail as string | undefined) ?? collected.detail,
  };
}
