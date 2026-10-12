/**
 * Conversation export: a transcript as Markdown, JSON, or a print-friendly HTML page ("Save as PDF" from the browser's print
 * dialog). The files are made from the stored messages only; nothing here reads the model or the network. PDF itself needs a
 * renderer the host brings (`export.renderPdf`): a PDF writer that can set Turkish, Greek or CJK text is not something to ship in a
 * dependency-free server.
 */

import { createHash } from "node:crypto";
import { EVENT_TYPES } from "./events.js";
import type { Conversation, ContentPart, ExportConfig, ExportLabels, Message, MessageFeedback } from "./types.js";

export const EXPORT_FORMATS = ["md", "json", "html", "pdf"] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export const DEFAULT_EXPORT_MAX_MESSAGES = 5000;

const EN: ExportLabels = {
  user: "You",
  assistant: "Assistant",
  exportedAt: "Exported",
  agent: "Agent",
  untitled: "Conversation",
  tools: "Tool calls",
  attachments: "Attachments",
  truncated: "Only the newest messages are included.",
};

const BUILT_IN_LABELS: Record<string, ExportLabels> = {
  en: EN,
  tr: {
    user: "Siz",
    assistant: "Asistan",
    exportedAt: "Dışa aktarma",
    agent: "Ajan",
    untitled: "Konuşma",
    tools: "Araç çağrıları",
    attachments: "Ekler",
    truncated: "Yalnızca en yeni mesajlar dahil edilmiştir.",
  },
};

/** The words for `locale` (`tr`, `tr-TR`, ...): the built-in table, with the host's `export.labels` laid over it; English when unknown. */
export function resolveLabels(locale: string | undefined, overrides: ExportConfig["labels"]): ExportLabels {
  const base = (locale ?? "en").toLowerCase().split(/[-_]/)[0] ?? "en";
  const key = Object.keys({ ...BUILT_IN_LABELS, ...(overrides ?? {}) }).find((k) => k.toLowerCase() === base) ?? "en";
  const custom = overrides && Object.entries(overrides).find(([k]) => k.toLowerCase() === base)?.[1];
  return { ...EN, ...(BUILT_IN_LABELS[key] ?? {}), ...(custom ?? {}) };
}

/** One tool call of an answer, as the event log remembers it. */
export interface ExportTool {
  name: string;
  args?: Record<string, unknown>;
  ok?: boolean;
  error?: string;
  durationMs?: number;
}

/** The part of a stored event the tool-call correlation reads (a {@link ConversationEvent} fits). */
export interface ToolLogEvent {
  seq: number;
  type: string;
  data: Record<string, unknown>;
  runId?: string;
}

/** The event types {@link toolCallsByAnswer} reads. */
export const TOOL_LOG_TYPES: string[] = [EVENT_TYPES.userMessage, EVENT_TYPES.toolUse, EVENT_TYPES.toolResult, EVENT_TYPES.message];

const camel = (key: string): string => key.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase());

/** A field of an event's `data`, whichever way its writer cased it: `tool_call_id` from this server, `toolCallId` from a host's own log. */
const eventField = (data: Record<string, unknown>, snake: string): unknown => data[snake] ?? data[camel(snake)];

const textOf = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);

type LoggedCall = ExportTool & { id: string };

/**
 * The tool calls of each assistant message, from the event log.
 *
 * A turn of this server writes its events with the run that made them, so the calls of a run belong to the answer that names the
 * run. A host that keeps its own log (a portal) writes events with no run id, and may name neither the answer (`message_id`) nor
 * anything else about it. Those are told apart by the order they were written in: the calls between a question (`user.message`)
 * and the answer that follows it are that answer's. Which stored message the answer is: the one it names (`message_id`), else the one
 * at the position it reports (`message_index`, an index into the whole transcript), else the one that says the same thing
 * (`content`), else - for an answer that says nothing about itself - the answers are lined up with the stored ones from the newest
 * back, since the log may have lost its oldest events but not its newest. An answer that reports something that matches no stored
 * message (one that was regenerated away) shows nothing, and neither does a log with more answers than there are stored ones to
 * put them to and nothing to tell them apart: a wrong list of tool calls is worse than none.
 *
 * `history` is the whole stored transcript, oldest first. Events are read in the order given (ascending `seq`).
 */
export function toolCallsByAnswer(events: Iterable<ToolLogEvent>, history: Message[]): Map<string, ExportTool[]> {
  const byRun = new Map<string, Map<string, LoggedCall>>();
  const runOfAnswer = new Map<string, string>();
  /** Answers that carry no run (or no message id), in the order they were written, with the calls written since the question. */
  const loose: Array<{ answerId?: string; index?: number; content?: string; truncated?: boolean; runId?: string; calls: LoggedCall[] }> = [];
  let open = new Map<string, LoggedCall>();

  for (const event of events) {
    const data = event.data ?? {};
    if (event.type === EVENT_TYPES.userMessage) {
      // a new question: calls the previous turn left without an answer (a stopped one) are not this turn's
      open = new Map();
    } else if (event.type === EVENT_TYPES.message) {
      const answerId = textOf(eventField(data, "message_id"));
      if (event.runId && answerId) {
        runOfAnswer.set(answerId, event.runId);
      } else {
        const index = eventField(data, "message_index");
        const content = textOf(data.content);
        loose.push({
          ...(answerId ? { answerId } : {}),
          ...(typeof index === "number" && Number.isInteger(index) ? { index } : {}),
          ...(content ? { content, truncated: data._truncated === true } : {}),
          ...(event.runId ? { runId: event.runId } : {}),
          calls: [...open.values()],
        });
      }
      open = new Map();
    } else if (event.type === EVENT_TYPES.toolUse || event.type === EVENT_TYPES.toolResult) {
      let bucket = open;
      if (event.runId) {
        bucket = byRun.get(event.runId) ?? new Map<string, LoggedCall>();
        byRun.set(event.runId, bucket);
      }
      const id = textOf(eventField(data, "tool_call_id")) ?? `${event.seq}`;
      const call = bucket.get(id) ?? { id, name: textOf(data.name) ?? "tool" };
      if (event.type === EVENT_TYPES.toolUse) {
        if (data.args && typeof data.args === "object") call.args = data.args as Record<string, unknown>;
      } else {
        call.ok = data.ok !== false;
        const error = textOf(data.error);
        if (error) call.error = error;
        const took = eventField(data, "duration_ms");
        if (typeof took === "number") call.durationMs = took;
      }
      bucket.set(id, call);
    }
  }

  const out = new Map<string, ExportTool[]>();
  const give = (answerId: string, calls: Iterable<LoggedCall>) => {
    const list = [...calls].map(({ id: _id, ...call }) => call);
    if (list.length > 0) out.set(answerId, list);
  };
  const assigned = new Set<string>();

  for (const [answerId, runId] of runOfAnswer) {
    assigned.add(answerId);
    give(answerId, byRun.get(runId)?.values() ?? []);
  }

  // The answers an id-less log can be about: the ones with text (an event is written for an answer that said something)
  const answers = history.filter((message) => message.role === "assistant" && messageText(message) !== "");
  const stored = new Set(answers.map((message) => message.id));
  const unnamed: typeof loose = [];
  for (const entry of loose) {
    const calls = [...(entry.runId ? (byRun.get(entry.runId)?.values() ?? []) : []), ...entry.calls];
    if (entry.answerId) {
      // it names its message; one that is gone from the transcript has nothing to show
      if (stored.has(entry.answerId) && !assigned.has(entry.answerId)) {
        assigned.add(entry.answerId);
        give(entry.answerId, calls);
      }
    } else {
      unnamed.push({ ...entry, calls });
    }
  }

  // The newest event first: an answer that was written again (regenerated) claims its message before the stale one can
  const isFree = (message: Message | undefined): message is Message => !!message && stored.has(message.id) && !assigned.has(message.id) && message.role === "assistant";
  const same = (entry: (typeof loose)[number], message: Message): boolean => {
    if (!entry.content) return false;
    const text = messageText(message);
    // (an event cut to its size limit ends in "...")
    return entry.truncated ? text.startsWith(entry.content.replace(/\.{3}$/, "")) : text === entry.content;
  };
  const unsaid: typeof loose = [];
  for (const entry of [...unnamed].reverse()) {
    // by position in the transcript - unless another message says exactly this and the one at that position does not (the
    // transcript was cut back since) - else by what it says
    const byIndex = entry.index !== undefined ? history[entry.index] : undefined;
    const bySaying = entry.content ? [...answers].reverse().find((message) => isFree(message) && same(entry, message)) : undefined;
    const target = isFree(byIndex) && !(bySaying && !same(entry, byIndex)) ? byIndex : bySaying;
    if (target) {
      assigned.add(target.id);
      give(target.id, entry.calls);
    } else if (!entry.content && entry.index === undefined) {
      unsaid.unshift(entry);
    }
  }

  // By order, from the newest back: answers that said nothing about themselves. A log with more of them than there are stored
  // answers to put them to has events of answers that are gone (regenerated, edited away) and no way to tell which: none is guessed.
  const free = answers.filter((message) => !assigned.has(message.id));
  if (unsaid.length <= free.length) {
    for (let i = 1; i <= unsaid.length; i++) give(free[free.length - i]!.id, unsaid[unsaid.length - i]!.calls);
  }
  return out;
}

export interface Transcript {
  conversation: Conversation;
  agentName: string;
  messages: Message[];
  /** Tool calls by the id of the assistant message that made them; absent when the export leaves tools out. */
  tools?: Map<string, ExportTool[]>;
  /** The conversation is longer than `export.maxMessages`: only the newest messages are here. */
  truncated: boolean;
  labels: ExportLabels;
  exportedAt: Date;
}

/** The text of a message, whatever shape its content has. */
export function messageText(message: Pick<Message, "content">): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as ContentPart[])
    .map((part) => {
      const p = part as { type?: string; text?: string; file?: { name?: string } };
      if (p.type === "text" || p.type === "input_text" || p.type === "output_text") return p.text ?? "";
      if (p.type === "image_url" || p.type === "input_image") return "[image]";
      if (p.type === "file") return `[file: ${p.file?.name ?? "file"}]`;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

const MAX_TOOL_ARGS_CHARS = 2000;

const argsText = (args: Record<string, unknown> | undefined): string => {
  if (!args || Object.keys(args).length === 0) return "";
  let text: string;
  try {
    text = JSON.stringify(args);
  } catch {
    return "";
  }
  return text.length > MAX_TOOL_ARGS_CHARS ? `${text.slice(0, MAX_TOOL_ARGS_CHARS)}...` : text;
};

const iso = (value: Date | string): string => new Date(value).toISOString();

/** The messages an export holds: what a person said and what the agent answered (system and raw tool messages are not part of the conversation they had). */
export function exportable(messages: Message[]): Message[] {
  return messages.filter((m) => m.role === "user" || m.role === "assistant");
}

const feedbackOf = (message: Message): MessageFeedback | undefined => {
  const feedback = message.feedback ?? (message.metadata?.feedback as MessageFeedback | undefined);
  return feedback && typeof feedback === "object" && (feedback.rating === "up" || feedback.rating === "down") ? feedback : undefined;
};

const speaker = (t: Transcript, message: Message) => (message.role === "user" ? t.labels.user : t.agentName || t.labels.assistant);

// ----------------------------------------------------------------------------
// JSON
// ----------------------------------------------------------------------------

export function renderJson(t: Transcript): string {
  const title = t.conversation.title;
  return JSON.stringify(
    {
      schemaVersion: 1,
      exportedAt: iso(t.exportedAt),
      conversation: {
        id: t.conversation.id,
        title: title ?? null,
        agentId: t.conversation.agentId,
        agentName: t.agentName,
        createdAt: iso(t.conversation.createdAt),
        updatedAt: iso(t.conversation.updatedAt),
        truncated: t.truncated,
      },
      messages: t.messages.map((message) => {
        const feedback = feedbackOf(message);
        const tools = t.tools?.get(message.id);
        return {
          id: message.id,
          role: message.role,
          content: messageText(message),
          createdAt: iso(message.createdAt),
          ...(message.files?.length ? { files: message.files.map((f) => ({ id: f.id, name: f.name, mimeType: f.mimeType, size: f.size })) } : {}),
          ...(message.role === "assistant" && message.metadata?.status ? { status: message.metadata.status } : {}),
          ...(feedback ? { feedback: { rating: feedback.rating, reasons: feedback.reasons ?? [], comment: feedback.comment ?? null } } : {}),
          ...(tools?.length ? { toolCalls: tools } : {}),
        };
      }),
    },
    null,
    2
  );
}

// ----------------------------------------------------------------------------
// Markdown
// ----------------------------------------------------------------------------

export function renderMarkdown(t: Transcript): string {
  const lines: string[] = [];
  lines.push(`# ${(t.conversation.title || t.labels.untitled).replace(/\r?\n/g, " ")}`, "");
  lines.push(`*${t.labels.agent}: ${t.agentName} · ${t.labels.exportedAt}: ${iso(t.exportedAt)}*`, "");
  if (t.truncated) lines.push(`> ${t.labels.truncated}`, "");
  lines.push("---", "");
  for (const message of t.messages) {
    lines.push(`**${speaker(t, message)}** · ${iso(message.createdAt)}`, "");
    const text = messageText(message);
    if (text) lines.push(text, "");
    if (message.files?.length) {
      lines.push(`*${t.labels.attachments}:* ${message.files.map((f) => `\`${f.name}\``).join(", ")}`, "");
    }
    const tools = t.tools?.get(message.id);
    if (tools?.length) {
      lines.push(`*${t.labels.tools}:*`, "");
      for (const tool of tools) {
        const args = argsText(tool.args);
        const outcome = tool.ok === false ? `failed${tool.error ? `: ${tool.error}` : ""}` : "ok";
        lines.push(`- \`${tool.name}\`${args ? ` ${args}` : ""} - ${outcome}${tool.durationMs !== undefined ? ` (${tool.durationMs} ms)` : ""}`);
      }
      lines.push("");
    }
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

// ----------------------------------------------------------------------------
// HTML (print view)
// ----------------------------------------------------------------------------

const escapeHtml = (text: string): string =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const PRINT_SCRIPT = "addEventListener('load',function(){setTimeout(function(){print()},150)})";
const PRINT_SCRIPT_HASH = `sha256-${createHash("sha256").update(PRINT_SCRIPT).digest("base64")}`;

const STYLE = `
  :root { color-scheme: light dark; }
  body { font: 15px/1.55 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; max-width: 780px; margin: 2rem auto; padding: 0 1rem; color: #1b1b1f; background: #fff; }
  h1 { font-size: 1.5rem; margin: 0 0 .25rem; }
  .meta { color: #5c5c66; font-size: .85rem; margin-bottom: 1.5rem; }
  .note { border-left: 3px solid #b9b9c4; padding: .25rem .75rem; color: #5c5c66; margin-bottom: 1rem; }
  .msg { margin: 0 0 1.25rem; padding: .75rem 1rem; border: 1px solid #dcdce4; border-radius: 8px; break-inside: avoid; }
  .msg.user { background: #f4f5fb; }
  .who { font-weight: 600; font-size: .85rem; margin-bottom: .35rem; }
  .who time { font-weight: 400; color: #5c5c66; margin-left: .5rem; }
  .body { white-space: pre-wrap; overflow-wrap: anywhere; }
  .extra { margin-top: .5rem; font-size: .85rem; color: #5c5c66; }
  .extra ul { margin: .25rem 0 0; padding-left: 1.25rem; }
  code { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: .85em; }
  @media (prefers-color-scheme: dark) { body { background: #16161a; color: #ececf1; } .msg { border-color: #34343c; } .msg.user { background: #1f2028; } .meta, .who time, .extra, .note { color: #a3a3ae; } }
  @media print { body { margin: 0; max-width: none; background: #fff; color: #000; } .msg, .msg.user { background: #fff; border-color: #bbb; } .meta, .who time, .extra, .note { color: #444; } }
`;

/** The Content-Security-Policy of the print page: no network, no frames, styles of its own, and - with `print` - exactly one script (the one that opens the print dialog). */
export function htmlContentSecurityPolicy(print: boolean): string {
  return `default-src 'none'; style-src 'unsafe-inline'; img-src data:; ${print ? `script-src '${PRINT_SCRIPT_HASH}'; ` : ""}base-uri 'none'; form-action 'none'`;
}

/** A standalone page; everything in it is escaped text (a message is never interpreted as markup). With `print` it opens the print dialog once loaded. */
export function renderHtml(t: Transcript, options: { print?: boolean; lang?: string } = {}): string {
  const title = escapeHtml(t.conversation.title || t.labels.untitled);
  const csp = htmlContentSecurityPolicy(!!options.print);
  const parts: string[] = [];
  for (const message of t.messages) {
    parts.push(
      `<section class="msg ${message.role}"><div class="who">${escapeHtml(speaker(t, message))}<time datetime="${iso(message.createdAt)}">${iso(message.createdAt)}</time></div>` +
        `<div class="body">${escapeHtml(messageText(message))}</div>`
    );
    if (message.files?.length) {
      parts.push(`<div class="extra">${escapeHtml(t.labels.attachments)}: ${message.files.map((f) => `<code>${escapeHtml(f.name)}</code>`).join(", ")}</div>`);
    }
    const tools = t.tools?.get(message.id);
    if (tools?.length) {
      parts.push(
        `<div class="extra">${escapeHtml(t.labels.tools)}:<ul>${tools
          .map((tool) => {
            const args = argsText(tool.args);
            const outcome = tool.ok === false ? `failed${tool.error ? `: ${tool.error}` : ""}` : "ok";
            return `<li><code>${escapeHtml(tool.name)}</code>${args ? ` <code>${escapeHtml(args)}</code>` : ""} - ${escapeHtml(outcome)}${tool.durationMs !== undefined ? ` (${tool.durationMs} ms)` : ""}</li>`;
          })
          .join("")}</ul></div>`
      );
    }
    parts.push("</section>");
  }
  return (
    `<!doctype html><html lang="${escapeHtml(options.lang ?? "en")}"><head><meta charset="utf-8">` +
    `<meta http-equiv="Content-Security-Policy" content="${csp}">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">` +
    `<title>${title}</title><style>${STYLE}</style></head><body>` +
    `<h1>${title}</h1><div class="meta">${escapeHtml(t.labels.agent)}: ${escapeHtml(t.agentName)} · ${escapeHtml(t.labels.exportedAt)}: ${iso(t.exportedAt)}</div>` +
    (t.truncated ? `<div class="note">${escapeHtml(t.labels.truncated)}</div>` : "") +
    parts.join("") +
    (options.print ? `<script>${PRINT_SCRIPT}</script>` : "") +
    `</body></html>`
  );
}

/** A file name for the download: the title (or the id) as something every file system accepts. */
export function exportFileName(conversation: Pick<Conversation, "id" | "title">, format: ExportFormat): string {
  const base = (conversation.title || conversation.id)
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80)
    .trim();
  return `${base || conversation.id}.${format === "md" ? "md" : format}`;
}
