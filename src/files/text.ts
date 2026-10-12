/**
 * The words and the shapes a conversation's attachments take in the model's input - pure, no storage, so
 * the turn assembler, the model wrapper and the tools share ONE wording and one reference format. (It is
 * the wording Console's agent runtime uses, so an agent behaves the same behind either.)
 *
 * Images travel as references, not bytes. An image in the model's input is
 * `{ type: 'image_url', image_url: { url: 'session-file://<fileId>' }, fileId, name }`; the bytes are read
 * from the storage provider only at the model call (see images.ts). The agent's saved state, the traces and
 * the SDK's token estimate therefore never carry base64, and an image can be put back in front of the
 * model on any later turn by its id. Every image part has a text handle in front of it
 * (`[Attached image: "name" (id ...)]`): without one the model has nothing to call the picture by once a
 * summary flattens the turn, and nothing to ask `session_files_view_image` for.
 *
 * Everything the turn adds to the person's text sits after `ATTACHMENT_BLOCK_MARKER`.
 */

import type { FileAttachment } from "../types.js";
import { SESSION_FILES_LIST_TOOL, SESSION_FILES_READ_TOOL, SESSION_FILES_VIEW_IMAGE_TOOL } from "./config.js";

export const ATTACHMENT_BLOCK_MARKER = '\n\n<attachments source="session-files">\n';
export const ATTACHMENT_BLOCK_END = "\n</attachments>";

/** What the person typed: the user turn without the block the assembler added. */
export function stripAttachmentBlock(text: string): string {
  const at = text.indexOf(ATTACHMENT_BLOCK_MARKER);
  return at >= 0 ? text.slice(0, at) : text;
}

export function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ----------------------------------------------------------------------------
// Image references
// ----------------------------------------------------------------------------

export const SESSION_FILE_URL_PREFIX = "session-file://";

export function sessionFileUrl(fileId: string): string {
  return `${SESSION_FILE_URL_PREFIX}${fileId}`;
}

/** The file id a `session-file://<id>` URL names, else null. */
export function parseSessionFileUrl(url: unknown): string | null {
  if (typeof url !== "string" || !url.startsWith(SESSION_FILE_URL_PREFIX)) return null;
  const id = url.slice(SESSION_FILE_URL_PREFIX.length).trim();
  return id.length > 0 ? id : null;
}

/** An image of the conversation as the model's input carries it. */
export interface ImageReferencePart {
  type: "image_url";
  image_url: { url: string };
  /** Outside `image_url` on purpose: a part that has been resolved to bytes keeps them, so it can be put back to a reference. */
  fileId: string;
  name: string;
}

export interface TextPart {
  type: "text";
  text: string;
}

export type ModelPart = TextPart | ImageReferencePart | { type: string; [key: string]: unknown };

export function imageReferencePart(fileId: string, name: string): ImageReferencePart {
  return { type: "image_url", image_url: { url: sessionFileUrl(fileId) }, fileId, name };
}

/** How an image is introduced: the person attached it now, sent it earlier, or the agent asked to look again. */
export type ImageAnchorKind = "attached" | "earlier" | "requested";

export function imageAnchorText(name: string, fileId: string, kind: ImageAnchorKind = "attached"): string {
  const label = kind === "earlier" ? "Earlier image" : kind === "requested" ? "Image you asked to see" : "Attached image";
  return `[${label}: "${escapeAttribute(name)}" (id ${fileId})]`;
}

/** The anchor and the reference of one image, in the order the model reads them. */
export function imageParts(fileId: string, name: string, kind: ImageAnchorKind = "attached"): ModelPart[] {
  return [{ type: "text", text: imageAnchorText(name, fileId, kind) }, imageReferencePart(fileId, name)];
}

/** The file id an image part refers to (its `fileId`, else the id in a `session-file://` URL), or null. */
export function imageFileIdOf(part: unknown): string | null {
  if (!part || typeof part !== "object") return null;
  const record = part as { type?: unknown; fileId?: unknown; image_url?: unknown };
  if (record.type !== "image_url") return null;
  if (typeof record.fileId === "string" && record.fileId) return record.fileId;
  const image = record.image_url;
  if (typeof image === "string") return parseSessionFileUrl(image);
  if (image && typeof image === "object") return parseSessionFileUrl((image as { url?: unknown }).url);
  return null;
}

/** Whether a part is an image that has been resolved to bytes (as opposed to a `session-file://` reference). */
export function isResolvedImagePart(part: unknown): boolean {
  if (!part || typeof part !== "object") return false;
  const record = part as { type?: unknown; image_url?: unknown };
  if (record.type !== "image_url") return false;
  const image = record.image_url;
  if (typeof image === "string") return !image.startsWith(SESSION_FILE_URL_PREFIX);
  if (image && typeof image === "object") {
    const { url, base64 } = image as { url?: unknown; base64?: unknown };
    return typeof base64 === "string" || (typeof url === "string" && !url.startsWith(SESSION_FILE_URL_PREFIX));
  }
  return false;
}

// ----------------------------------------------------------------------------
// The attachment block
// ----------------------------------------------------------------------------

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

export interface AttachmentCounts {
  /** Documents whose text is in the turn. */
  documentsInline: number;
  /** Documents the agent reads with the session file tools. */
  documentsPaged: number;
  /** Documents of which only the start is in the turn (the agent cannot read pages). */
  documentsTruncated: number;
  /** Documents with no readable text (conversion failed or not supported). */
  documentsUnreadable: number;
  /** Files that expired or were deleted since. */
  filesGone: number;
  /** Images the model is shown. */
  imagesShown: number;
  /** Images the model is not shown (the agent cannot read images, or an older one that fell out of the window). */
  imagesHidden: number;
}

/**
 * The opening line of the block. It names EVERY attachment by kind, so a model (and any summary after it)
 * knows what the person sent even when most of it is in the tools or below as pictures: "The person
 * attached 4 files: 3 documents to read with the tools (session_files_list, session_files_read), 1 image
 * shown below."
 */
export function attachmentSummaryLine(counts: AttachmentCounts): string {
  const total =
    counts.documentsInline +
    counts.documentsPaged +
    counts.documentsTruncated +
    counts.documentsUnreadable +
    counts.filesGone +
    counts.imagesShown +
    counts.imagesHidden;
  const parts: string[] = [];
  if (counts.documentsInline > 0) parts.push(`${plural(counts.documentsInline, "document")} included below`);
  if (counts.documentsPaged > 0) {
    parts.push(
      `${plural(counts.documentsPaged, "document")} to read with the tools (${SESSION_FILES_LIST_TOOL}, ${SESSION_FILES_READ_TOOL})`
    );
  }
  if (counts.documentsTruncated > 0) parts.push(`${plural(counts.documentsTruncated, "document")} included below in part`);
  if (counts.documentsUnreadable > 0) parts.push(`${plural(counts.documentsUnreadable, "document")} whose text could not be extracted`);
  if (counts.filesGone > 0) parts.push(`${plural(counts.filesGone, "file")} no longer available`);
  if (counts.imagesShown > 0) parts.push(`${plural(counts.imagesShown, "image")} shown below`);
  if (counts.imagesHidden > 0) parts.push(`${plural(counts.imagesHidden, "image")} not shown`);
  return `The person attached ${plural(total, "file")}: ${parts.join(", ")}.`;
}

export function wrapAttachmentBlock(lines: string[]): string {
  return lines.length > 0 ? `${ATTACHMENT_BLOCK_MARKER}${lines.join("\n")}${ATTACHMENT_BLOCK_END}` : "";
}

export function documentBlock(name: string, id: string, text: string, extra = ""): string {
  return `<document name="${escapeAttribute(name)}" id="${id}"${extra}>\n${text}\n</document>`;
}

/** A line saying an image is attached but the model is not shown it. */
export function hiddenImageNote(
  entry: Pick<FileAttachment, "id" | "name">,
  why: "no_vision" | "older",
  viewImageTool: boolean
): string {
  const name = escapeAttribute(entry.name);
  if (why === "no_vision") {
    return `[Image "${name}" (id ${entry.id}) is attached, but this agent cannot read images.]`;
  }
  return (
    `[Image "${name}" (id ${entry.id}) was attached earlier and is not shown in this request.` +
    `${viewImageTool ? ` Use ${SESSION_FILES_VIEW_IMAGE_TOOL} to look at it again.` : ""}]`
  );
}

/** The text that tells the model a tool result is followed by the image it asked for. */
export function viewImageToolResult(fileId: string, name: string): string {
  return JSON.stringify({
    ok: true,
    fileId,
    name,
    note: `The image is shown to you in the message that follows. (${SESSION_FILES_VIEW_IMAGE_TOOL})`,
  });
}
