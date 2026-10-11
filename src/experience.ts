/**
 * What a chat client shows around an agent - welcome text, starters, the switches of message actions, history management,
 * feedback and export - resolved from the server's settings, the agent's own and whatever the host put in `AgentInfo.metadata`.
 * The result is published in `AgentInfo.metadata` (`welcome`, `starters`, `experience`) and the routes enforce the same switches.
 */

import { DEFAULT_FEEDBACK_REASONS, MAX_STARTERS } from "./types.js";
import type {
  AgentExperience,
  AgentInfo,
  AgentServerConfig,
  ConversationStarter,
  ExportConfig,
  FeedbackConfig,
  ResolvedExperience,
} from "./types.js";

export const MAX_WELCOME_CHARS = 4000;
export const MAX_STARTER_TEXT_CHARS = 500;
export const MAX_STARTER_LABEL_CHARS = 80;
export const DEFAULT_MAX_COMMENT_CHARS = 1000;
/** Longest reason code a feedback request may carry. */
export const MAX_REASON_CHARS = 64;

const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

const bool = (value: unknown): boolean | undefined => (typeof value === "boolean" ? value : undefined);

/** The starters in a form clients can use: text and label trimmed and cut, empty ones dropped, at most {@link MAX_STARTERS}. */
export function normalizeStarters(raw: unknown): ConversationStarter[] {
  if (!Array.isArray(raw)) return [];
  const out: ConversationStarter[] = [];
  for (const entry of raw) {
    const text = typeof entry === "string" ? entry : isObject(entry) && typeof entry.text === "string" ? entry.text : "";
    const trimmed = text.trim().slice(0, MAX_STARTER_TEXT_CHARS);
    if (!trimmed) continue;
    const label = isObject(entry) && typeof entry.label === "string" ? entry.label.trim().slice(0, MAX_STARTER_LABEL_CHARS) : "";
    out.push({
      text: trimmed,
      ...(label ? { label } : {}),
      ...(isObject(entry) && entry.autoSend === true ? { autoSend: true } : {}),
    });
    if (out.length >= MAX_STARTERS) break;
  }
  return out;
}

/** The welcome text, or undefined when there is none. */
export function normalizeWelcome(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const text = raw.trim();
  return text ? text.slice(0, MAX_WELCOME_CHARS) : undefined;
}

/** The reason codes of a list: unique, trimmed, lower-case, `[a-z0-9_.-]` only, at most {@link MAX_REASON_CHARS} characters each. */
export function normalizeReasons(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string") continue;
    const code = entry.trim().toLowerCase();
    if (code && code.length <= MAX_REASON_CHARS && /^[a-z0-9_.-]+$/.test(code) && !out.includes(code)) out.push(code);
  }
  return out;
}

/** What the host put in `AgentInfo.metadata.experience`, read leniently into an {@link AgentExperience}. */
export function experienceFromMetadata(metadata: Record<string, unknown> | undefined): AgentExperience | undefined {
  const raw = metadata?.experience;
  if (!isObject(raw)) return undefined;
  const group = <K extends string>(value: unknown, keys: readonly K[]): Partial<Record<K, boolean>> | undefined => {
    if (!isObject(value)) return undefined;
    const out: Partial<Record<K, boolean>> = {};
    for (const key of keys) {
      const flag = bool(value[key]);
      if (flag !== undefined) out[key] = flag;
    }
    return out;
  };
  const feedback = isObject(raw.feedback)
    ? {
        ...(group(raw.feedback, ["enabled", "comments"] as const) ?? {}),
        ...(normalizeReasons(raw.feedback.reasons) ? { reasons: normalizeReasons(raw.feedback.reasons) } : {}),
      }
    : undefined;
  return {
    ...(group(raw.messageActions, ["copy", "regenerate", "edit"] as const) && { messageActions: group(raw.messageActions, ["copy", "regenerate", "edit"] as const) }),
    ...(group(raw.history, ["rename", "pin", "bulkDelete"] as const) && { history: group(raw.history, ["rename", "pin", "bulkDelete"] as const) }),
    ...(feedback && { feedback }),
    ...(group(raw.export, ["enabled", "includeTools"] as const) && { export: group(raw.export, ["enabled", "includeTools"] as const) }),
  };
}

/** `a` with the fields `b` sets laid over it, group by group (a field `b` leaves out keeps `a`'s value). */
export function mergeExperience(a: AgentExperience | undefined, b: AgentExperience | undefined): AgentExperience {
  const out: AgentExperience = { ...(a ?? {}) };
  if (!b) return out;
  if (b.welcome !== undefined) out.welcome = b.welcome;
  if (b.starters !== undefined) out.starters = b.starters;
  for (const group of ["messageActions", "history", "feedback", "export"] as const) {
    if (b[group]) (out as Record<string, unknown>)[group] = { ...((a?.[group] as object | undefined) ?? {}), ...(b[group] as object) };
  }
  return out;
}

export interface ResolveInputs {
  config: Pick<AgentServerConfig, "experience" | "feedback" | "export">;
  agentExperience?: AgentExperience;
  /** `AgentInfo.metadata` as the host wrote it. */
  metadata?: Record<string, unknown>;
  /** A title is generated for this agent's conversations. */
  titles: boolean;
  /** The server can render a PDF. */
  pdf: boolean;
}

/** The experience of one agent: the server's, laid over by the agent's, laid over by the host's `AgentInfo.metadata.experience`. */
export function effectiveExperience(inputs: Pick<ResolveInputs, "config" | "agentExperience" | "metadata">): AgentExperience {
  return mergeExperience(
    mergeExperience(inputs.config.experience, inputs.agentExperience),
    experienceFromMetadata(inputs.metadata)
  );
}

/** Every switch resolved to a value. */
export function resolveExperience(inputs: ResolveInputs): ResolvedExperience {
  const experience = effectiveExperience(inputs);
  const feedbackConfig: FeedbackConfig = inputs.config.feedback ?? {};
  const exportConfig: ExportConfig = inputs.config.export ?? {};

  const maxComment =
    typeof feedbackConfig.maxCommentLength === "number" && Number.isFinite(feedbackConfig.maxCommentLength) && feedbackConfig.maxCommentLength >= 0
      ? Math.floor(feedbackConfig.maxCommentLength)
      : DEFAULT_MAX_COMMENT_CHARS;
  const comments = experience.feedback?.comments !== false && maxComment > 0;
  const enabledExport = experience.export?.enabled ?? exportConfig.enabled ?? true;
  const formats = enabledExport ? ["md", "json", "html", ...(inputs.pdf ? ["pdf"] : [])] : [];

  return {
    messageActions: {
      copy: experience.messageActions?.copy ?? true,
      regenerate: experience.messageActions?.regenerate ?? true,
      edit: experience.messageActions?.edit ?? true,
    },
    history: {
      rename: experience.history?.rename ?? true,
      pin: experience.history?.pin ?? true,
      bulkDelete: experience.history?.bulkDelete ?? true,
    },
    feedback: {
      enabled: experience.feedback?.enabled ?? feedbackConfig.enabled ?? true,
      comments,
      reasons: normalizeReasons(experience.feedback?.reasons) ?? normalizeReasons(feedbackConfig.reasons) ?? [...DEFAULT_FEEDBACK_REASONS],
      maxCommentLength: comments ? maxComment : 0,
    },
    export: {
      enabled: enabledExport,
      includeTools: enabledExport && (experience.export?.includeTools ?? exportConfig.includeTools ?? false),
      formats,
    },
    titles: inputs.titles,
  };
}

/**
 * `AgentInfo.metadata` as the API shows it: the host's keys, with `welcome`, `starters` and `experience` filled in from the settings
 * (a `welcome` or `starters` the host put in `metadata` itself wins; so do the fields of its `experience`).
 */
export function experienceMetadata(
  info: Pick<AgentInfo, "metadata">,
  inputs: ResolveInputs
): { welcome?: string; starters?: ConversationStarter[]; experience: ResolvedExperience } {
  const experience = effectiveExperience(inputs);
  const welcome = normalizeWelcome(info.metadata?.welcome) ?? normalizeWelcome(experience.welcome);
  const starters = info.metadata?.starters !== undefined ? normalizeStarters(info.metadata.starters) : normalizeStarters(experience.starters);
  return {
    ...(welcome ? { welcome } : {}),
    ...(starters.length > 0 ? { starters } : {}),
    experience: resolveExperience(inputs),
  };
}
