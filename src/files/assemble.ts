/**
 * What the model is told about the files a user message carries.
 *
 *  - The text of the documents of ONE message goes into the turn as `<document name id>` blocks when it fits
 *    `files.inlineMaxTokens` (estimated characters / 4). Over it, an agent that has the session file tools gets a
 *    short note listing the files and reads them in pages (`session_files_list` / `session_files_read`); any
 *    other agent gets the start of the documents, cut at that size, and a `file_truncated` warning.
 *  - The block opens with a line naming EVERY attachment by kind, whatever mix the message carries.
 *  - Images become image parts when the agent's model accepts images (`files.vision`), else a text note. An image
 *    part is a REFERENCE (`session-file://<id>`) with a text handle in front of it; the bytes are read where the
 *    model is called (images.ts). Only the last `files.carryRecentImages` earlier image-carrying messages keep
 *    showing their images; older ones are only named.
 *  - Everything added to the person's text sits after `ATTACHMENT_BLOCK_MARKER`; the stored message keeps what the
 *    person typed and its `files`, so the same input is rebuilt on every later turn.
 *
 * Pure with respect to storage: the caller says how to find a record and how to read its text.
 */

import type { FileAttachment, FileRecord, Message, TurnWarning } from "../types.js";
import { isVisionImageMime, type ResolvedFilesConfig, SESSION_FILES_LIST_TOOL, SESSION_FILES_READ_TOOL } from "./config.js";
import {
  attachmentSummaryLine,
  documentBlock,
  escapeAttribute,
  hiddenImageNote,
  imageAnchorText,
  imageReferencePart,
  wrapAttachmentBlock,
  type ImageReferencePart,
  type ModelPart,
} from "./text.js";
import { pageCount } from "./tools.js";

export interface AttachmentSource {
  /** The record of an attachment of this conversation; null when it is gone (expired, deleted). */
  find(fileId: string): Promise<FileRecord | null>;
  /** The text of a file; null when it has none. May throw (the converter failed). */
  text(record: FileRecord): Promise<string | null>;
}

export interface AssembledAttachments {
  /** Text appended to the person's message (starts with `ATTACHMENT_BLOCK_MARKER`); '' when there is nothing to add. */
  block: string;
  /** The images the model is shown, as references. */
  images: ImageReferencePart[];
  /** `inline` = the documents are in the turn; `paged` = the agent reads them with the tools; `truncated` = only the start is in. */
  mode: "none" | "inline" | "paged" | "truncated";
  warnings: TurnWarning[];
}

export const NO_ATTACHMENTS: AssembledAttachments = { block: "", images: [], mode: "none", warnings: [] };

/** The token estimate the inline / paged decision uses: characters / 4. */
export function estimateTokens(chars: number): number {
  return Math.ceil(chars / 4);
}

export interface AssembleInput {
  /** What the message carries (its stored `files`). */
  attachments: FileAttachment[];
  source: AttachmentSource;
  cfg: ResolvedFilesConfig;
  /** This message's images are shown (vision is on and the message is among the recent image turns). */
  showImages: boolean;
  /** The agent can read documents in pages. */
  canPage: boolean;
  /** `session_files_view_image` is there to look at a hidden image again. */
  viewImageTool: boolean;
  signal?: AbortSignal;
  /** Called for a document that could not be read (to log it). */
  onError?: (file: FileAttachment, error: unknown) => void;
}

export async function assembleAttachments(input: AssembleInput): Promise<AssembledAttachments> {
  const { attachments, source, cfg } = input;
  if (attachments.length === 0) return NO_ATTACHMENTS;

  const warnings: TurnWarning[] = [];
  const hiddenNotes: string[] = [];
  const images: ImageReferencePart[] = [];
  const gone: FileAttachment[] = [];
  const documents: Array<{ file: FileAttachment; text: string | null }> = [];
  let imagesHidden = 0;
  let noVision = 0;

  for (const file of attachments) {
    input.signal?.throwIfAborted?.();
    const record = await source.find(file.id);
    if (!record) {
      gone.push(file);
      continue;
    }
    if (isVisionImageMime(record.mimeType)) {
      if (!cfg.vision) {
        hiddenNotes.push(hiddenImageNote(file, "no_vision", false));
        imagesHidden += 1;
        noVision += 1;
      } else if (!input.showImages) {
        hiddenNotes.push(hiddenImageNote(file, "older", input.viewImageTool));
        imagesHidden += 1;
      } else {
        images.push(imageReferencePart(file.id, file.name));
      }
      continue;
    }
    let text: string | null = null;
    try {
      text = await source.text(record);
    } catch (error) {
      input.onError?.(file, error);
      warnings.push({ code: "file_unreadable", message: `File "${file.name}" could not be read.`, fileId: file.id });
    }
    documents.push({ file, text });
  }
  if (noVision > 0) {
    warnings.push({
      code: "images_not_supported",
      message: `${noVision === 1 ? "An image was" : `${noVision} images were`} attached, but this agent does not read images.`,
      count: noVision,
    });
  }

  const readable = documents.filter((doc): doc is { file: FileAttachment; text: string } => doc.text !== null);
  const unreadable = documents.filter((doc) => doc.text === null);
  const totalChars = readable.reduce((sum, doc) => sum + doc.text.length, 0);
  const totalTokens = estimateTokens(totalChars);
  const fits = readable.length > 0 && totalTokens <= cfg.inlineMaxTokens;
  const mode: AssembledAttachments["mode"] =
    readable.length === 0 ? "none" : fits ? "inline" : input.canPage ? "paged" : "truncated";

  const lines: string[] = [
    attachmentSummaryLine({
      documentsInline: mode === "inline" ? readable.length : 0,
      documentsPaged: mode === "paged" ? readable.length : 0,
      documentsTruncated: mode === "truncated" ? readable.length : 0,
      documentsUnreadable: unreadable.length,
      filesGone: gone.length,
      imagesShown: images.length,
      imagesHidden,
    }),
  ];

  if (mode === "inline") {
    for (const { file, text } of readable) lines.push(documentBlock(file.name, file.id, text));
  } else if (mode === "paged") {
    lines.push(
      `The person attached ${readable.length} file${readable.length === 1 ? "" : "s"} that ${readable.length === 1 ? "is" : "are"} too long to include here` +
        ` (about ${totalTokens} tokens; the limit for inlining is ${cfg.inlineMaxTokens}). Read ${readable.length === 1 ? "it" : "them"} with` +
        ` ${SESSION_FILES_LIST_TOOL} and ${SESSION_FILES_READ_TOOL}({ fileId, page }):`,
      ...readable.map(({ file, text }) => {
        const pages = pageCount(text.length, cfg.readPageChars);
        return `- "${escapeAttribute(file.name)}" (id ${file.id}, ${pages} page${pages === 1 ? "" : "s"})`;
      })
    );
  } else if (mode === "truncated") {
    let room = cfg.inlineMaxTokens * 4;
    let cut = 0;
    lines.push(
      `The person attached ${readable.length} file${readable.length === 1 ? "" : "s"} that ${readable.length === 1 ? "is" : "are"} too long to include in full` +
        ` (about ${totalTokens} tokens; the limit is ${cfg.inlineMaxTokens}). Only the start ${readable.length === 1 ? "is" : "of each is"} below; the rest could not be read.`
    );
    for (const { file, text } of readable) {
      if (text.length <= room) {
        lines.push(documentBlock(file.name, file.id, text));
        room -= text.length;
        continue;
      }
      cut += 1;
      if (room <= 0) {
        lines.push(`[File "${escapeAttribute(file.name)}" (id ${file.id}) is not included: there is no room left.]`);
        continue;
      }
      lines.push(documentBlock(file.name, file.id, text.slice(0, room), ` truncated="true" shown_chars="${room}" total_chars="${text.length}"`));
      room = 0;
    }
    warnings.push({
      code: "file_truncated",
      message: `${cut === 1 ? "A file was" : `${cut} files were`} longer than ${cfg.inlineMaxTokens} tokens, and this agent cannot read files in pages: only the start was given to it.`,
      count: cut,
    });
  }

  for (const doc of unreadable) {
    lines.push(`[File "${escapeAttribute(doc.file.name)}" (id ${doc.file.id}) is attached, but its text could not be extracted.]`);
  }
  for (const file of gone) {
    lines.push(`[File "${escapeAttribute(file.name)}" (id ${file.id}) is no longer available.]`);
  }
  lines.push(...hiddenNotes);

  return { block: wrapAttachmentBlock(lines), images, mode, warnings };
}

/**
 * The content of the user turn: the text alone (unchanged) or the text followed by each image's handle and
 * reference - the handle is what the model, and a summary of a long conversation, can name the picture by.
 */
export function buildUserTurnContent(text: string, assembled: AssembledAttachments): string | ModelPart[] {
  const full = `${text}${assembled.block}`;
  if (assembled.images.length === 0) return full;
  return [
    { type: "text", text: full },
    ...assembled.images.flatMap((image): ModelPart[] => [{ type: "text", text: imageAnchorText(image.name, image.fileId) }, image]),
  ];
}

/** Which user messages show their images: the one being answered and the last `carry` image turns before it. */
export function messagesShowingImages(history: Message[], currentMessageId: string | undefined, carry: number): Set<string> {
  const bearing = history.filter(
    (message) => message.role === "user" && (message.files ?? []).some((file) => isVisionImageMime(file.mimeType))
  );
  const currentCarries = currentMessageId !== undefined && bearing.some((message) => message.id === currentMessageId);
  const limit = Math.max(0, carry) + (currentCarries ? 1 : 0);
  return new Set(bearing.slice(Math.max(0, bearing.length - limit)).map((message) => message.id));
}

export interface AssembleHistoryInput {
  currentMessageId?: string;
  source: AttachmentSource;
  cfg: ResolvedFilesConfig;
  canPage: boolean;
  viewImageTool: boolean;
  signal?: AbortSignal;
  onError?: AssembleInput["onError"];
}

/**
 * The attachments of every user message of the history, assembled the same way each turn (so the model sees the
 * same input as before). Only the warnings of the message being answered are reported.
 */
export async function assembleHistory(
  history: Message[],
  input: AssembleHistoryInput
): Promise<{ byMessage: Map<string, AssembledAttachments>; warnings: TurnWarning[] }> {
  const show = messagesShowingImages(history, input.currentMessageId, input.cfg.carryRecentImages);
  const byMessage = new Map<string, AssembledAttachments>();
  for (const message of history) {
    if (message.role !== "user" || !message.files?.length) continue;
    byMessage.set(
      message.id,
      await assembleAttachments({
        attachments: message.files,
        source: input.source,
        cfg: input.cfg,
        showImages: show.has(message.id),
        canPage: input.canPage,
        viewImageTool: input.viewImageTool,
        signal: input.signal,
        onError: input.onError,
      })
    );
  }
  return {
    byMessage,
    warnings: input.currentMessageId ? (byMessage.get(input.currentMessageId)?.warnings ?? []) : [],
  };
}
