/**
 * Puts a conversation's images in front of the model at the model call - and only there.
 *
 * In the agent's input an image is a reference (`session-file://<fileId>`, see text.ts), so the saved
 * state, the traces and the SDK's token estimate carry a few dozen characters per image instead of
 * megabytes of base64 (a 55 KB photo made the SDK count ~18 000 tokens and compact a conversation that was
 * nowhere near full). Two things turn the references into bytes:
 *
 *  - {@link withSessionImages} wraps the agent's MODEL (the host does that when it builds the agent): what the
 *    SDK sends - `invoke`, `stream` and the model `bindTools` returns - passes through it first, so the SDK
 *    itself never sees the bytes. This is also what lets `session_files_view_image` show an image again.
 *  - For an agent whose model is not wrapped (or for Chat Completions / Responses agents, where the server makes
 *    the call) the server resolves the references itself when it hands over the input, and puts them back
 *    before it stores a paused state ({@link dehydrateImages}).
 *
 * Either way a request carries at most `maxImages` images / `maxImageBytes` bytes: the NEWEST win, an older
 * one becomes a text placeholder naming the file so the model can say what it cannot see.
 */

import { currentTurnFiles } from "./turn.js";
import {
  escapeAttribute,
  imageFileIdOf,
  imageParts,
  imageReferencePart,
  isResolvedImagePart,
  type ModelPart,
} from "./text.js";
import { SESSION_FILES_VIEW_IMAGE_TOOL } from "./config.js";

/** Where an image's record and bytes come from - the conversation's files in production. */
export interface ImageSource {
  /** The image file if it is an image of this conversation, else null. */
  find(fileId: string): Promise<{ name: string; size: number } | null>;
  /** null when the bytes are gone. */
  read(fileId: string): Promise<{ bytes: Buffer; mediaType: string } | null>;
}

/** How a resolved image is written in the request. */
export type ImageFormat =
  /**
   * agent-sdk: `{ type: 'image_url', image_url: { url: 'data:...' }, fileId, name }`. A `data:` URL is the one form
   * every adapter of the SDK understands (the native providers read only URLs and data URLs; LangChain models
   * take it as it is); `fileId` / `name` let a paused state put the part back to a reference.
   */
  | "sdk"
  /** agent-sdk's typed `{ image_url: { base64, media_type } }`: read by LangChain-adapted models only. */
  | "sdk-base64"
  /** Chat Completions: `{ type: 'image_url', image_url: { url: 'data:...' } }` */
  | "data-url"
  /** Responses API: `{ type: 'input_image', image_url: 'data:...' }` */
  | "responses";

export interface ResolveImagesOptions {
  source: ImageSource;
  /** Most images one request carries. */
  maxImages: number;
  /** Most image bytes (before base64) one request carries. */
  maxBytes: number;
  /** A placeholder may point at `session_files_view_image`. */
  viewImageTool?: boolean;
  format: ImageFormat;
}

type LooseMessage = Record<string, unknown> & { role?: unknown; content?: unknown; name?: unknown };

function resolvedPart(format: ImageFormat, fileId: string, name: string, bytes: Buffer, mediaType: string): ModelPart {
  const base64 = bytes.toString("base64");
  if (format === "sdk-base64") {
    return { type: "image_url", image_url: { base64, media_type: mediaType }, fileId, name };
  }
  const url = `data:${mediaType};base64,${base64}`;
  if (format === "sdk") return { type: "image_url", image_url: { url }, fileId, name };
  return format === "responses" ? { type: "input_image", image_url: url } : { type: "image_url", image_url: { url } };
}

interface Slot {
  message: number;
  part: number;
  fileId: string;
  name: string | undefined;
}

function megabytes(bytes: number): string {
  return `${Math.round((bytes / 1_000_000) * 10) / 10} MB`;
}

/** Whether any message carries a `session-file://` reference. */
export function hasImageReferences(messages: unknown): boolean {
  if (!Array.isArray(messages)) return false;
  return messages.some(
    (entry) =>
      Array.isArray((entry as LooseMessage | null)?.content) &&
      ((entry as LooseMessage).content as unknown[]).some(
        (part) => imageFileIdOf(part) !== null && !isResolvedImagePart(part)
      )
  );
}

/**
 * The messages with every image reference read from the source and written as `format`, within the budget.
 * Nothing is written back: the array it is given is not touched. Messages without references come back as they are.
 */
export async function resolveImageReferences(messages: unknown[], options: ResolveImagesOptions): Promise<unknown[]> {
  const slots: Slot[] = [];
  messages.forEach((entry, messageIndex) => {
    const content = (entry as LooseMessage | null)?.content;
    if (!Array.isArray(content)) return;
    content.forEach((part, partIndex) => {
      const fileId = imageFileIdOf(part);
      // Already inline (a caller's own bytes) is not ours to touch
      if (!fileId || isResolvedImagePart(part)) return;
      slots.push({ message: messageIndex, part: partIndex, fileId, name: (part as { name?: unknown }).name as string | undefined });
    });
  });
  if (slots.length === 0) return messages;

  const known = new Map<string, { name: string; size: number } | null>();
  for (const fileId of new Set(slots.map((slot) => slot.fileId))) {
    known.set(fileId, await options.source.find(fileId).catch(() => null));
  }

  // The newest images win the budget: walk back from the end
  const replacement = new Map<number, ModelPart>();
  const shown: number[] = [];
  let count = 0;
  let total = 0;
  for (let i = slots.length - 1; i >= 0; i -= 1) {
    const slot = slots[i]!;
    const info = known.get(slot.fileId);
    const name = info?.name ?? slot.name ?? slot.fileId;
    if (!info) {
      replacement.set(i, { type: "text", text: `[Image "${escapeAttribute(name)}" is no longer available]` });
      continue;
    }
    if (count + 1 > options.maxImages || total + info.size > options.maxBytes) {
      const limit = `${options.maxImages} image${options.maxImages === 1 ? "" : "s"} / ${megabytes(options.maxBytes)}`;
      replacement.set(i, {
        type: "text",
        text:
          `[Image "${escapeAttribute(name)}" (id ${slot.fileId}) is not shown: a request carries at most ${limit}, and newer images took the room.` +
          `${options.viewImageTool ? ` Use ${SESSION_FILES_VIEW_IMAGE_TOOL} to look at it again.` : ""}]`,
      });
      continue;
    }
    count += 1;
    total += info.size;
    shown.push(i);
  }

  for (const i of shown) {
    const slot = slots[i]!;
    const name = known.get(slot.fileId)?.name ?? slot.name ?? slot.fileId;
    const data = await options.source.read(slot.fileId).catch(() => null);
    replacement.set(
      i,
      data
        ? resolvedPart(options.format, slot.fileId, name, data.bytes, data.mediaType)
        : { type: "text", text: `[Image "${escapeAttribute(name)}" is no longer available]` }
    );
  }

  const result = messages.slice();
  const byMessage = new Map<number, Map<number, ModelPart>>();
  slots.forEach((slot, i) => {
    const part = replacement.get(i);
    if (!part) return;
    const forMessage = byMessage.get(slot.message) ?? new Map<number, ModelPart>();
    forMessage.set(slot.part, part);
    byMessage.set(slot.message, forMessage);
  });
  for (const [messageIndex, parts] of byMessage) {
    const message = result[messageIndex] as LooseMessage;
    result[messageIndex] = {
      ...message,
      content: (message.content as unknown[]).map((part, partIndex) => parts.get(partIndex) ?? part),
    };
  }
  return result;
}

/**
 * `value` with every resolved image part that remembers its file (`fileId`) written back as a reference.
 * Used on a paused agent state, so the stored state never holds image bytes. Anything else is left alone.
 */
export function dehydrateImages<T>(value: T): T {
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (!node || typeof node !== "object") return node;
    const record = node as Record<string, unknown>;
    if (record.type === "image_url" && typeof record.fileId === "string" && record.fileId && isResolvedImagePart(record)) {
      return imageReferencePart(record.fileId, typeof record.name === "string" ? record.name : record.fileId);
    }
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(record)) out[key] = walk(inner);
    return out;
  };
  return walk(value) as T;
}

// ----------------------------------------------------------------------------
// The tool result that asks for an image
// ----------------------------------------------------------------------------

function roleOf(message: LooseMessage): string | undefined {
  if (typeof message.role === "string") return message.role;
  const typed = message as { _getType?: () => string; getType?: () => string };
  return typed.getType?.() ?? typed._getType?.();
}

/** `{ fileId, name }` when a tool message is the result of `session_files_view_image`. */
function viewedImage(message: LooseMessage): { fileId: string; name: string } | null {
  if (roleOf(message) !== "tool" || message.name !== SESSION_FILES_VIEW_IMAGE_TOOL) return null;
  if (typeof message.content !== "string") return null;
  try {
    const parsed = JSON.parse(message.content) as { ok?: unknown; fileId?: unknown; name?: unknown };
    if (parsed.ok === true && typeof parsed.fileId === "string" && parsed.fileId) {
      return { fileId: parsed.fileId, name: typeof parsed.name === "string" && parsed.name ? parsed.name : parsed.fileId };
    }
  } catch {
    // A refusal ("not attached to this conversation") is plain text: nothing to show
  }
  return null;
}

/**
 * The request with every `session_files_view_image` result followed by a user message carrying the image
 * (a tool result is text on every provider's wire). The message goes after the whole run of tool results of
 * that assistant turn - providers want the results adjacent to the calls they answer.
 */
export function expandViewedImages(messages: unknown[]): unknown[] {
  const out: unknown[] = [];
  let pending: Array<{ fileId: string; name: string }> = [];
  let changed = false;
  const flush = () => {
    if (pending.length === 0) return;
    const unique = [...new Map(pending.map((entry) => [entry.fileId, entry])).values()];
    out.push({
      role: "user",
      content: [
        { type: "text", text: unique.length === 1 ? "Here is the image you asked to look at." : "Here are the images you asked to look at." },
        ...unique.flatMap((entry) => imageParts(entry.fileId, entry.name, "requested")),
      ],
    });
    pending = [];
    changed = true;
  };
  for (const entry of messages) {
    const message = entry as LooseMessage | null;
    if (message && typeof message === "object" && roleOf(message) === "tool") {
      out.push(entry);
      const viewed = viewedImage(message);
      if (viewed) pending.push(viewed);
      continue;
    }
    flush();
    out.push(entry);
  }
  flush();
  return changed ? out : messages;
}

// ----------------------------------------------------------------------------
// The model wrapper
// ----------------------------------------------------------------------------

/** Set on a model (and on what its `bindTools` returns) that {@link withSessionImages} wrapped. */
export const SESSION_IMAGES_MARK = Symbol.for("cognipeer.agent-server.session-images");

/** Whether a model was wrapped by {@link withSessionImages}. */
export function isSessionImageModel(model: unknown): boolean {
  return !!model && typeof model === "object" && (model as Record<symbol, unknown>)[SESSION_IMAGES_MARK] === true;
}

type AnyFn = (...args: any[]) => any;
interface WrappableModel {
  invoke?: AnyFn;
  stream?: AnyFn;
  bindTools?: AnyFn;
}

export interface WithSessionImagesOptions {
  /** How the picture is written in what the model receives (default `"sdk"`; `"sdk-base64"` for a LangChain model that wants agent-sdk's typed form). */
  format?: ImageFormat;
}

/**
 * Wraps an agent-sdk model so the `session-file://` references in what the SDK sends are read from the
 * conversation's storage at the call, within the agent's `files.maxImages` / `files.maxImageBytes`. Build the
 * agent with the wrapped model and the server stops resolving images for it:
 *
 * ```ts
 * const agent = createSmartAgent({
 *   model: withSessionImages(model),
 *   tools: [...myTools, ...createSessionFileTools({ viewImage: true })],
 *   tokenCounter: createImageAwareTokenCounter(),
 * });
 * ```
 *
 * Outside a server turn (no conversation to read from) the wrapper passes everything through unchanged.
 */
export function withSessionImages<T extends object>(input: T, options: WithSessionImagesOptions = {}): T {
  const model = input as T & WrappableModel;
  if (!model || typeof model !== "object") return input;

  const prepare = async (messages: unknown): Promise<unknown> => {
    if (!Array.isArray(messages)) return messages;
    const turn = currentTurnFiles();
    if (!turn) return messages;
    const expanded = turn.viewImageTool ? expandViewedImages(messages) : messages;
    if (!hasImageReferences(expanded)) return expanded;
    return resolveImageReferences(expanded, {
      source: turn.images,
      maxImages: turn.cfg.maxImages,
      maxBytes: turn.cfg.maxImageBytes,
      viewImageTool: turn.viewImageTool,
      format: options.format ?? "sdk",
    });
  };

  const overrides: Record<string, unknown> = {};
  if (typeof model.bindTools === "function") {
    const bindTools = model.bindTools.bind(model);
    // Tools are bound per call, and the bound model is the one that runs
    overrides.bindTools = (tools: unknown, bindOptions?: unknown) =>
      withSessionImages(bindTools(tools, bindOptions) as object, options);
  }
  if (typeof model.invoke === "function") {
    const invoke = model.invoke.bind(model);
    overrides.invoke = async (messages: unknown, ...rest: unknown[]) => invoke(await prepare(messages), ...rest);
  }
  if (typeof model.stream === "function") {
    const stream = model.stream.bind(model);
    overrides.stream = async function* withImages(messages: unknown, ...rest: unknown[]) {
      const started = stream(await prepare(messages), ...rest);
      // LangChain's `stream` returns a promise of the iterator; the SDK adapter's is the iterator
      yield* ((typeof started?.then === "function" ? await started : started) as AsyncIterable<unknown>);
    };
  }

  // A proxy rather than a copy: a class-based model keeps its prototype methods and private state
  return new Proxy(model, {
    get(target, prop) {
      if (prop === SESSION_IMAGES_MARK) return true;
      // (own keys only: `constructor`, `toString` and the like belong to the wrapped model, not to the object the overrides are kept in)
      if (typeof prop === "string" && Object.prototype.hasOwnProperty.call(overrides, prop)) return overrides[prop];
      const value = Reflect.get(target, prop, target);
      // (the class itself is not a method: bound, it would lose its name, which providers are recognised by)
      return typeof value === "function" && prop !== "constructor" ? value.bind(target) : value;
    },
    has(target, prop) {
      return prop === SESSION_IMAGES_MARK || Reflect.has(target, prop);
    },
  }) as T;
}

// ----------------------------------------------------------------------------
// The token estimate
// ----------------------------------------------------------------------------

/** About what a provider bills for one ordinary image (OpenAI-style tiles, Anthropic's ~w*h/750 at typical sizes). */
export const IMAGE_TOKENS = 850;

const INLINE_BASE64 = /"base64":"[A-Za-z0-9+/=]{256,}"/g;
const DATA_URL = /data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]{256,}/gi;
const SESSION_FILE_REFERENCE = /session-file:\/\//g;

/** The SDK's own heuristic (`defaultTokenCounter`): ASCII at 4 characters a token, everything else at 1.5. */
export function approximateTokens(text: string): number {
  if (!text) return 0;
  // eslint-disable-next-line no-control-regex
  const nonAscii = (text.match(/[^\x00-\x7F]/g) || []).length;
  return Math.ceil((text.length - nonAscii) / 4 + nonAscii / 1.5);
}

/**
 * A token counter for the agent SDK that does not bill an image's bytes as text. The SDK estimates a request
 * by flattening every message to text and counting characters; an image that reaches it as inline base64
 * would be read as text too (a 55 KB photo came out at ~18 000 tokens against ~425 for the provider, and the
 * SDK compacted a conversation that was nowhere near its window). A base64 payload - and a `session-file://`
 * reference - costs {@link IMAGE_TOKENS} instead of its length. Pass it as `createSmartAgent({ tokenCounter })`.
 */
export function createImageAwareTokenCounter(base: (text: string) => number = approximateTokens): (text: string) => number {
  return (text: string): number => {
    if (!text) return 0;
    let images = 0;
    let stripped = text;
    if (stripped.includes("base64")) {
      stripped = stripped
        .replace(INLINE_BASE64, () => {
          images += 1;
          return '"base64":"<image>"';
        })
        .replace(DATA_URL, () => {
          images += 1;
          return "data:image;base64,<image>";
        });
    }
    if (stripped.includes("session-file://")) {
      images += stripped.match(SESSION_FILE_REFERENCE)?.length ?? 0;
    }
    return base(stripped) + images * IMAGE_TOKENS;
  };
}
