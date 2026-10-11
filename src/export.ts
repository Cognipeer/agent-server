/**
 * Conversation export: a transcript as Markdown, JSON, or a print-friendly HTML page ("Save as PDF" from the browser's print
 * dialog). The files are made from the stored messages only; nothing here reads the model or the network. PDF itself needs a
 * renderer the host brings (`export.renderPdf`): a PDF writer that can set Turkish, Greek or CJK text is not something to ship in a
 * dependency-free server.
 */

import { createHash } from "node:crypto";
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
