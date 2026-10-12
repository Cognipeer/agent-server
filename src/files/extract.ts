/**
 * Turning an attachment into text for the agent.
 *
 * The default extractor reads text-like files (`text/*`, JSON, XML, YAML, ...) as UTF-8 and - when the
 * optional peer `@cognipeer/to-markdown` is installed - converts PDF, Word, Excel, PowerPoint and similar
 * files to Markdown. A host can take over with `files.extractText(file, bytes)`.
 *
 * Extraction can be slow (a PDF) and the same text is asked for again for every page and every turn, so
 * results are kept in a small in-process cache bounded by `files.extractCacheBytes`.
 */

import type { ExtractTextFile, FilesConfig } from "../types.js";
import { isConvertibleMime, isVisionImageMime, isPlainTextMime } from "./config.js";

type ToMarkdown = (input: Buffer, options?: { fileName?: string }) => Promise<unknown>;

let toMarkdown: Promise<ToMarkdown | null> | undefined;

/** `@cognipeer/to-markdown`'s `convertToMarkdown`, or null when the package is not installed. */
export function loadToMarkdown(): Promise<ToMarkdown | null> {
  toMarkdown ??= (async () => {
    // A variable specifier: the package is an optional peer, so bundlers must not try to resolve it
    const name = "@cognipeer/to-markdown";
    try {
      const mod = (await import(/* @vite-ignore */ name)) as { convertToMarkdown?: ToMarkdown; default?: { convertToMarkdown?: ToMarkdown } };
      const fn = mod.convertToMarkdown ?? mod.default?.convertToMarkdown;
      return typeof fn === "function" ? fn : null;
    } catch {
      return null;
    }
  })();
  return toMarkdown;
}

/** Forget what was learned about `@cognipeer/to-markdown` (tests install and remove it). */
export function resetToMarkdownLoader(): void {
  toMarkdown = undefined;
}

let warnedMissingConverter = false;

function markdownOf(result: unknown): string | null {
  if (typeof result === "string") return result;
  if (result && typeof result === "object") {
    const record = result as { markdown?: unknown; content?: unknown; text?: unknown };
    for (const candidate of [record.markdown, record.content, record.text]) {
      if (typeof candidate === "string") return candidate;
    }
  }
  return null;
}

/** Bytes that look like text: no NUL in the first 8 KB and valid UTF-8. */
function looksLikeText(bytes: Buffer): boolean {
  const head = bytes.subarray(0, 8192);
  if (head.includes(0)) return false;
  try {
    // `stream`: a character cut in two by the end of the sample is not an error
    new TextDecoder("utf-8", { fatal: true }).decode(head, { stream: bytes.length > head.length });
    return true;
  } catch {
    return false;
  }
}

function decodeText(bytes: Buffer): string {
  const text = bytes.toString("utf8");
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** The default extractor. `null` = the file has no text this server can read. */
export async function defaultExtractText(file: ExtractTextFile, bytes: Buffer): Promise<string | null> {
  if (isVisionImageMime(file.mimeType)) return null;
  if (isPlainTextMime(file.mimeType)) return decodeText(bytes);
  if (isConvertibleMime(file.mimeType)) {
    const convert = await loadToMarkdown();
    if (!convert) {
      if (!warnedMissingConverter) {
        warnedMissingConverter = true;
        console.warn(
          "[AgentServer] A PDF / Office file was attached but @cognipeer/to-markdown is not installed, so the agent cannot read it. " +
            "Install it (npm install @cognipeer/to-markdown) or set files.extractText."
        );
      }
      return null;
    }
    return markdownOf(await convert(bytes, { fileName: file.name }));
  }
  // An unknown type that is plainly text (a .log, a source file) is read like one
  if ((file.mimeType === "application/octet-stream" || !file.mimeType) && looksLikeText(bytes)) return decodeText(bytes);
  return null;
}

export interface TextExtractor {
  /**
   * The text of a file. `load` reads its bytes (called only on a cache miss); `null` when the file has no
   * readable text or its bytes are gone. Throws when the hook or the converter fails (nothing is cached then).
   */
  extract(
    file: ExtractTextFile,
    load: () => Promise<Buffer | null>,
    hook?: FilesConfig["extractText"]
  ): Promise<string | null>;
  clear(): void;
}

/** An extractor whose results live in memory, least recently used out first, up to `cacheBytes` (0: no cache). */
export function createTextExtractor(cacheBytes: number): TextExtractor {
  const cache = new Map<string, { text: string | null; bytes: number }>();
  const inflight = new Map<string, Promise<string | null>>();
  let used = 0;

  const remember = (id: string, text: string | null) => {
    if (cacheBytes <= 0) return;
    const bytes = text === null ? 64 : text.length * 2;
    if (bytes > cacheBytes) return;
    const existing = cache.get(id);
    if (existing) used -= existing.bytes;
    cache.set(id, { text, bytes });
    used += bytes;
    for (const [key, entry] of cache) {
      if (used <= cacheBytes) break;
      if (key === id) continue;
      cache.delete(key);
      used -= entry.bytes;
    }
  };

  return {
    async extract(file, load, hook) {
      const hit = cache.get(file.id);
      if (hit) {
        // most recently used goes last
        cache.delete(file.id);
        cache.set(file.id, hit);
        return hit.text;
      }
      const running = inflight.get(file.id);
      if (running) return running;

      const work = (async () => {
        const bytes = await load();
        if (!bytes) return null;
        let text: string | null | undefined;
        if (hook) text = await hook(file, bytes);
        if (text === undefined) text = await defaultExtractText(file, bytes);
        const normalised = typeof text === "string" ? text : null;
        remember(file.id, normalised);
        return normalised;
      })();
      inflight.set(file.id, work);
      try {
        return await work;
      } finally {
        inflight.delete(file.id);
      }
    },
    clear() {
      cache.clear();
      used = 0;
    },
  };
}
