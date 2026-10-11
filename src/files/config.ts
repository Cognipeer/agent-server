/**
 * The settings side of attachments: defaults, the merge of the server's `files` option with an agent's
 * override, and the MIME helpers. Pure - no storage - so adapters and tests can use it too.
 */

import type { AgentFilesConfig, AttachmentsCapability, FilesConfig } from "../types.js";

/** Names of the read-only tools an SDK agent reads attachments with (the same as Console's, so approval rules line up). */
export const SESSION_FILES_LIST_TOOL = "session_files_list";
export const SESSION_FILES_READ_TOOL = "session_files_read";
/** Looks at an image of the conversation again; the model sees it in the message that follows the tool result. */
export const SESSION_FILES_VIEW_IMAGE_TOOL = "session_files_view_image";

/** What an unset field of `files` falls back to. */
export const FILES_DEFAULTS = {
  enabled: true,
  maxFiles: 10,
  inlineMaxTokens: 30_000,
  readPageChars: 20_000,
  retentionDays: 30,
  vision: false,
  attachNewUploads: false,
  maxImages: 6,
  maxImageBytes: 12_000_000,
  carryRecentImages: 2,
  extractCacheBytes: 32 * 1024 * 1024,
  purgeIntervalMs: 3_600_000,
} as const;

export interface ResolvedFilesConfig {
  enabled: boolean;
  maxFiles: number;
  /** Bytes. */
  maxFileSize: number;
  allowedMimeTypes: string[];
  inlineMaxTokens: number;
  readPageChars: number;
  retentionDays: number;
  vision: boolean;
  attachNewUploads: boolean;
  maxImages: number;
  maxImageBytes: number;
  carryRecentImages: number;
  extractText?: FilesConfig["extractText"];
}

const positive = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;

/** A number >= 0 (0 is a real choice: "never", "off"). */
const nonNegative = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;

/**
 * The effective settings of one agent: defaults, then the server's `files`, then the agent's own.
 * `defaultMaxFileSize` is what an unset `maxFileSize` becomes; `providerMaxFileBytes` caps whatever was set.
 */
export function resolveFilesConfig(
  server: FilesConfig | undefined,
  agent: AgentFilesConfig | undefined,
  limits: { defaultMaxFileSize: number; providerMaxFileBytes: number }
): ResolvedFilesConfig {
  const pick = <K extends keyof AgentFilesConfig>(key: K): AgentFilesConfig[K] =>
    agent?.[key] !== undefined ? agent[key] : server?.[key];

  const allowed = pick("allowedMimeTypes");
  const maxFileSize = Math.floor(positive(pick("maxFileSize"), limits.defaultMaxFileSize));
  return {
    enabled: pick("enabled") !== false,
    maxFiles: Math.floor(positive(pick("maxFiles"), FILES_DEFAULTS.maxFiles)),
    maxFileSize: Math.min(maxFileSize, limits.providerMaxFileBytes),
    allowedMimeTypes: Array.isArray(allowed)
      ? allowed.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
      : [],
    inlineMaxTokens: Math.floor(positive(pick("inlineMaxTokens"), FILES_DEFAULTS.inlineMaxTokens)),
    readPageChars: Math.floor(positive(pick("readPageChars"), FILES_DEFAULTS.readPageChars)),
    retentionDays: nonNegative(pick("retentionDays"), FILES_DEFAULTS.retentionDays),
    vision: pick("vision") === true,
    attachNewUploads: pick("attachNewUploads") === true,
    maxImages: Math.floor(positive(pick("maxImages"), FILES_DEFAULTS.maxImages)),
    maxImageBytes: Math.floor(positive(pick("maxImageBytes"), FILES_DEFAULTS.maxImageBytes)),
    carryRecentImages: Math.floor(nonNegative(pick("carryRecentImages"), FILES_DEFAULTS.carryRecentImages)),
    extractText: pick("extractText"),
  };
}

/** `AgentInfo.capabilities.attachments` for an agent with these settings. */
export function attachmentsCapability(cfg: ResolvedFilesConfig): Required<AttachmentsCapability> {
  return {
    enabled: cfg.enabled,
    maxFiles: cfg.maxFiles,
    maxFileSize: cfg.maxFileSize,
    allowedMimeTypes: cfg.allowedMimeTypes,
    acceptsImages: cfg.vision,
  };
}

// ----------------------------------------------------------------------------
// MIME
// ----------------------------------------------------------------------------

/** The part of a Content-Type before the parameters, lower-cased. */
export function baseMimeType(mimeType: string): string {
  return mimeType.split(";")[0]!.trim().toLowerCase();
}

/** A well-formed `type/subtype` (what is safe to echo back in a `Content-Type` header). */
export function isWellFormedMime(mimeType: string): boolean {
  return /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(mimeType);
}

const MIME_BY_EXTENSION: Record<string, string> = {
  pdf: "application/pdf",
  txt: "text/plain",
  log: "text/plain",
  md: "text/markdown",
  markdown: "text/markdown",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  json: "application/json",
  yaml: "application/yaml",
  yml: "application/yaml",
  toml: "application/toml",
  html: "text/html",
  htm: "text/html",
  xml: "application/xml",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
};

/**
 * The MIME type a file is stored under: what the caller declared, without parameters; a declared
 * `application/octet-stream` (or nothing, or something that is not a MIME type) is guessed from the extension.
 */
export function resolveUploadMimeType(declared: string | undefined | null, fileName: string): string {
  const base = declared ? baseMimeType(declared) : "";
  if (base && base !== "application/octet-stream" && isWellFormedMime(base)) return base;
  const extension = fileName.includes(".") ? fileName.split(".").pop()!.toLowerCase() : "";
  return MIME_BY_EXTENSION[extension] ?? (base && isWellFormedMime(base) ? base : "application/octet-stream");
}

export function isImageMime(mimeType: string | undefined): boolean {
  return Boolean(mimeType && mimeType.toLowerCase().startsWith("image/"));
}

/** The pictures a model can be shown (what every provider accepts); an SVG or a TIFF is a document, not an image, to the agent. */
export function isVisionImageMime(mimeType: string | undefined): boolean {
  return Boolean(mimeType && /^image\/(png|jpe?g|gif|webp)$/.test(baseMimeType(mimeType)));
}

/** Types whose bytes ARE the text. */
export function isPlainTextMime(mimeType: string | undefined): boolean {
  if (!mimeType) return false;
  const mime = baseMimeType(mimeType);
  return (
    mime.startsWith("text/") ||
    mime === "application/json" ||
    mime === "application/xml" ||
    mime === "application/yaml" ||
    mime === "application/x-yaml" ||
    mime === "application/toml" ||
    mime === "application/javascript" ||
    mime === "application/x-ndjson" ||
    mime === "application/sql" ||
    mime.endsWith("+json") ||
    mime.endsWith("+xml")
  );
}

/** Types `@cognipeer/to-markdown` turns into text. */
export function isConvertibleMime(mimeType: string | undefined): boolean {
  if (!mimeType) return false;
  const mime = baseMimeType(mimeType);
  return (
    mime === "application/pdf" ||
    mime === "application/msword" ||
    mime === "application/vnd.ms-excel" ||
    mime === "application/vnd.ms-powerpoint" ||
    mime === "application/rtf" ||
    mime === "application/epub+zip" ||
    mime.startsWith("application/vnd.openxmlformats-officedocument.") ||
    mime.startsWith("application/vnd.oasis.opendocument.")
  );
}

/** Whether an upload of this type is accepted: `allowed` is a list of types and `image/*` style wildcards; empty means any. */
export function isMimeAllowed(mimeType: string, allowed: readonly string[]): boolean {
  if (allowed.length === 0) return true;
  const mime = baseMimeType(mimeType);
  return allowed.some((entry) => {
    const pattern = baseMimeType(entry);
    if (pattern === "*/*" || pattern === "*") return true;
    return pattern.endsWith("/*") ? mime.startsWith(pattern.slice(0, -1)) : pattern === mime;
  });
}

/** Types a browser may show in place when asked to; everything else (SVG, HTML, ...) is only ever a download. */
const INLINE_SAFE_TYPES = [
  /^image\/(png|jpe?g|gif|webp|avif|bmp)$/,
  /^application\/pdf$/,
  /^text\/(plain|markdown|csv)$/,
  /^application\/json$/,
];

export type FileDisposition = "inline" | "attachment";

/**
 * How a file is offered: pictures open in place, everything else downloads unless the caller asks for
 * `inline` AND the type is one a browser shows without running anything.
 */
export function fileDisposition(mimeType: string, requested?: FileDisposition): FileDisposition {
  const type = baseMimeType(mimeType);
  if (!INLINE_SAFE_TYPES.some((pattern) => pattern.test(type))) return "attachment";
  if (requested) return requested;
  return type.startsWith("image/") ? "inline" : "attachment";
}

/**
 * `Content-Disposition` for a file name that came from outside: control characters, quotes, slashes and
 * `;` out of the plain `filename`, non-ASCII kept in the RFC 5987 `filename*` form.
 */
export function contentDispositionHeader(disposition: FileDisposition, fileName: string): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = fileName.replace(/[\u0000-\u001f\u007f]/g, "").replace(/[\\/]/g, "_").trim().slice(0, 180) || "file";
  const ascii = cleaned.replace(/[^\x20-\x7e]/g, "_").replace(/["%;]/g, "_");
  const encoded = encodeURIComponent(cleaned).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${disposition}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/** Whether `contentType` is a form encoding (`multipart/*`, `application/x-www-form-urlencoded`), which the upload route does not take. */
export function isFormContentType(contentType: string | string[] | undefined): boolean {
  const raw = Array.isArray(contentType) ? contentType[0] : contentType;
  if (!raw) return false;
  const base = baseMimeType(raw);
  return base.startsWith("multipart/") || base === "application/x-www-form-urlencoded";
}

/** Whether `POST /files` is called with a form encoding: answered 415 by the server, so an adapter need not read the body. */
export function isUnsupportedUploadRequest(method: string, routePath: string, contentType: string | string[] | undefined): boolean {
  if (method.toUpperCase() !== "POST") return false;
  const path = routePath.split("?")[0]!.replace(/\/+$/, "");
  return path === "/files" && isFormContentType(contentType);
}

/** Whether an upload request carries the file as its raw body instead of JSON. */
export function isRawUploadRequest(method: string, routePath: string, contentType: string | string[] | undefined): boolean {
  if (method.toUpperCase() !== "POST") return false;
  const path = routePath.split("?")[0]!.replace(/\/+$/, "");
  if (path !== "/files") return false;
  const raw = Array.isArray(contentType) ? contentType[0] : contentType;
  if (!raw) return false; // no declared type: the JSON body it always was
  const base = baseMimeType(raw);
  return !(base === "application/json" || base.endsWith("+json"));
}
