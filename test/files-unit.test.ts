/**
 * The pure parts of attachments: settings, MIME handling, the wording, text extraction, image references,
 * the model wrapper, the token estimate and the tools. No server, no storage.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FILES_DEFAULTS,
  SESSION_FILES_LIST_TOOL,
  SESSION_FILES_READ_TOOL,
  SESSION_FILES_VIEW_IMAGE_TOOL,
  createImageAwareTokenCounter,
  createSessionFileTools,
  isRawUploadRequest,
  isSessionImageModel,
  withSessionImages,
} from "../src/index.js";
import {
  attachmentsCapability,
  contentDispositionHeader,
  fileDisposition,
  isMimeAllowed,
  isVisionImageMime,
  resolveFilesConfig,
  resolveUploadMimeType,
} from "../src/files/config.js";
import { assembleAttachments, assembleHistory, buildUserTurnContent, messagesShowingImages, type AttachmentSource } from "../src/files/assemble.js";
import { createTextExtractor, defaultExtractText, resetToMarkdownLoader } from "../src/files/extract.js";
import {
  IMAGE_TOKENS,
  dehydrateImages,
  expandViewedImages,
  hasImageReferences,
  resolveImageReferences,
  type ImageSource,
} from "../src/files/images.js";
import { imageReferencePart, parseSessionFileUrl, sessionFileUrl, viewImageToolResult } from "../src/files/text.js";
import { runWithTurnFiles, type TurnFiles } from "../src/files/turn.js";
import type { FileRecord, Message } from "../src/index.js";

const limits = { defaultMaxFileSize: 10 * 1024 * 1024, providerMaxFileBytes: 1_000_000_000 };

describe("resolveFilesConfig", () => {
  it("falls back to the defaults", () => {
    const cfg = resolveFilesConfig(undefined, undefined, limits);
    expect(cfg).toMatchObject({
      enabled: true,
      maxFiles: 10,
      maxFileSize: 10 * 1024 * 1024,
      allowedMimeTypes: [],
      inlineMaxTokens: 30_000,
      readPageChars: 20_000,
      retentionDays: 30,
      vision: false,
      attachNewUploads: false,
      maxImages: 6,
      maxImageBytes: 12_000_000,
      carryRecentImages: 2,
    });
  });

  it("lets an agent override single fields of the server's settings", () => {
    const cfg = resolveFilesConfig(
      { maxFiles: 3, retentionDays: 7, vision: false, allowedMimeTypes: ["text/*"] },
      { vision: true, maxFiles: 5, retentionDays: 0, enabled: false },
      limits
    );
    expect(cfg).toMatchObject({ maxFiles: 5, retentionDays: 0, vision: true, enabled: false, allowedMimeTypes: ["text/*"] });
  });

  it("caps the file size at what the provider holds, and ignores nonsense", () => {
    expect(resolveFilesConfig({ maxFileSize: 50_000 }, { maxFileSize: 20_000 }, { ...limits, providerMaxFileBytes: 10_000 }).maxFileSize).toBe(10_000);
    const junk = resolveFilesConfig({ maxFiles: -1, inlineMaxTokens: Number.NaN, retentionDays: -4 }, { readPageChars: 0 }, limits);
    expect(junk).toMatchObject({ maxFiles: 10, inlineMaxTokens: 30_000, retentionDays: 30, readPageChars: 20_000 });
  });

  it("describes itself as a capability", () => {
    const cfg = resolveFilesConfig({ vision: true, maxFiles: 4, allowedMimeTypes: ["image/*"] }, undefined, limits);
    expect(attachmentsCapability(cfg)).toEqual({
      enabled: true,
      maxFiles: 4,
      maxFileSize: 10 * 1024 * 1024,
      allowedMimeTypes: ["image/*"],
      acceptsImages: true,
    });
    expect(FILES_DEFAULTS.retentionDays).toBe(30);
  });
});

describe("MIME handling", () => {
  it("normalises the declared type and guesses a missing one from the extension", () => {
    expect(resolveUploadMimeType("text/plain; charset=utf-8", "a.txt")).toBe("text/plain");
    expect(resolveUploadMimeType("application/octet-stream", "photo.PNG")).toBe("image/png");
    expect(resolveUploadMimeType(undefined, "notes.md")).toBe("text/markdown");
    expect(resolveUploadMimeType("not a mime\r\nX: y", "data.csv")).toBe("text/csv");
    expect(resolveUploadMimeType("application/octet-stream", "blob.weird")).toBe("application/octet-stream");
  });

  it("matches allowed types and wildcards", () => {
    expect(isMimeAllowed("image/png", [])).toBe(true);
    expect(isMimeAllowed("image/png", ["image/*"])).toBe(true);
    expect(isMimeAllowed("application/pdf", ["image/*", "text/plain"])).toBe(false);
    expect(isMimeAllowed("text/plain; charset=utf-8", ["TEXT/plain"])).toBe(true);
    expect(isMimeAllowed("anything/x", ["*/*"])).toBe(true);
  });

  it("only shows a model the pictures every provider takes", () => {
    for (const ok of ["image/png", "image/jpeg", "image/jpg", "image/gif", "image/webp"]) expect(isVisionImageMime(ok)).toBe(true);
    for (const no of ["image/svg+xml", "image/tiff", "application/pdf", undefined]) expect(isVisionImageMime(no)).toBe(false);
  });

  it("serves active content as a download, even when asked for it inline", () => {
    expect(fileDisposition("image/png", "inline")).toBe("inline");
    expect(fileDisposition("text/html", "inline")).toBe("attachment");
    expect(fileDisposition("image/svg+xml", "inline")).toBe("attachment");
    expect(fileDisposition("application/pdf", "inline")).toBe("inline");
    expect(fileDisposition("application/pdf")).toBe("attachment");
    expect(fileDisposition("image/png")).toBe("inline");
  });

  it("never lets a file name break out of the Content-Disposition header", () => {
    const header = contentDispositionHeader("attachment", 'ev"il\r\nSet-Cookie: x=1; ../name ü.txt');
    expect(header).not.toMatch(/[\r\n]/);
    expect(header).toContain('filename="');
    expect(header.split('filename="')[1]!.split('"')[0]).not.toMatch(/["/;\\]/);
    expect(header).toContain("filename*=UTF-8''");
    expect(contentDispositionHeader("inline", "")).toContain('filename="file"');
  });

  it("recognises an upload of raw bytes", () => {
    expect(isRawUploadRequest("POST", "/files", "image/png")).toBe(true);
    expect(isRawUploadRequest("POST", "/files/", "text/plain; charset=utf-8")).toBe(true);
    expect(isRawUploadRequest("POST", "/files", "application/json")).toBe(false);
    expect(isRawUploadRequest("POST", "/files", "application/json; charset=utf-8")).toBe(false);
    expect(isRawUploadRequest("POST", "/files", "application/vnd.api+json")).toBe(false);
    expect(isRawUploadRequest("POST", "/files", undefined)).toBe(false);
    expect(isRawUploadRequest("GET", "/files", "image/png")).toBe(false);
    expect(isRawUploadRequest("POST", "/conversations", "image/png")).toBe(false);
    expect(isRawUploadRequest("POST", "/files?name=a.png", ["image/png"])).toBe(true);
  });
});

describe("image references", () => {
  it("names a file in a session-file URL and reads it back", () => {
    expect(sessionFileUrl("file_1")).toBe("session-file://file_1");
    expect(parseSessionFileUrl("session-file://file_1")).toBe("file_1");
    expect(parseSessionFileUrl("https://x/y.png")).toBeNull();
    expect(parseSessionFileUrl("session-file://")).toBeNull();
    expect(imageReferencePart("file_1", "a.png")).toEqual({
      type: "image_url",
      image_url: { url: "session-file://file_1" },
      fileId: "file_1",
      name: "a.png",
    });
  });
});

function imageSource(images: Record<string, { name: string; bytes: Buffer; mediaType?: string }>, reads: string[] = []): ImageSource {
  return {
    async find(id) {
      const found = images[id];
      return found ? { name: found.name, size: found.bytes.length } : null;
    },
    async read(id) {
      const found = images[id];
      reads.push(id);
      return found ? { bytes: found.bytes, mediaType: found.mediaType ?? "image/png" } : null;
    },
  };
}

const userWith = (...ids: string[]) => ({
  role: "user",
  content: [{ type: "text", text: "look" }, ...ids.map((id) => imageReferencePart(id, `${id}.png`))],
});

describe("resolveImageReferences", () => {
  it("reads each reference once and writes it in the format asked for", async () => {
    const reads: string[] = [];
    const source = imageSource({ a: { name: "a.png", bytes: Buffer.from("AAAA") } }, reads);
    const messages = [userWith("a"), userWith("a")];
    const options = { source, maxImages: 6, maxBytes: 1_000, format: "sdk" as const };
    const url = `data:image/png;base64,${Buffer.from("AAAA").toString("base64")}`;

    // for agent-sdk: a data URL, which both its native and its LangChain adapters understand; the part remembers its file
    const sdk = (await resolveImageReferences(messages, options)) as any[];
    expect(sdk[0].content[1]).toEqual({ type: "image_url", image_url: { url }, fileId: "a", name: "a.png" });
    expect(((await resolveImageReferences(messages, { ...options, format: "sdk-base64" })) as any[])[0].content[1]).toEqual({
      type: "image_url",
      image_url: { base64: Buffer.from("AAAA").toString("base64"), media_type: "image/png" },
      fileId: "a",
      name: "a.png",
    });
    // for the APIs the server calls itself: the provider's own shape, nothing of ours in it
    expect(((await resolveImageReferences(messages, { ...options, format: "data-url" })) as any[])[0].content[1]).toEqual({
      type: "image_url",
      image_url: { url },
    });
    expect(((await resolveImageReferences(messages, { ...options, format: "responses" })) as any[])[0].content[1]).toEqual({
      type: "input_image",
      image_url: url,
    });
    // the messages it was given are untouched
    expect(messages[0]!.content[1]).toMatchObject({ image_url: { url: "session-file://a" } });
    expect(hasImageReferences(messages)).toBe(true);
    expect(hasImageReferences(sdk)).toBe(false);
    expect(reads.length).toBeGreaterThan(0);
  });

  it("keeps the newest images within the budget and names the rest", async () => {
    const source = imageSource({
      a: { name: "a.png", bytes: Buffer.alloc(10) },
      b: { name: "b.png", bytes: Buffer.alloc(10) },
      c: { name: "c.png", bytes: Buffer.alloc(10) },
    });
    const out = (await resolveImageReferences([userWith("a", "b"), userWith("c")], {
      source,
      maxImages: 2,
      maxBytes: 1_000_000,
      viewImageTool: true,
      format: "sdk",
    })) as any[];
    expect(out[0].content[1]).toMatchObject({ type: "text" });
    expect(out[0].content[1].text).toContain('"a.png" (id a) is not shown');
    expect(out[0].content[1].text).toContain(SESSION_FILES_VIEW_IMAGE_TOOL);
    expect(out[0].content[2]).toMatchObject({ type: "image_url", fileId: "b" });
    expect(out[1].content[1]).toMatchObject({ type: "image_url", fileId: "c" });

    const bytes = (await resolveImageReferences([userWith("a", "b", "c")], { source, maxImages: 9, maxBytes: 15, format: "sdk" })) as any[];
    expect(bytes[0].content.slice(1).map((p: any) => p.type)).toEqual(["text", "text", "image_url"]);
  });

  it("says so when an image is gone, and leaves a caller's own bytes alone", async () => {
    const own = { type: "image_url", image_url: { base64: "QQ==", media_type: "image/png" } };
    const out = (await resolveImageReferences([{ role: "user", content: [imageReferencePart("lost", "lost.png"), own] }], {
      source: imageSource({}),
      maxImages: 6,
      maxBytes: 1_000,
      format: "sdk",
    })) as any[];
    expect(out[0].content[0]).toEqual({ type: "text", text: '[Image "lost.png" is no longer available]' });
    expect(out[0].content[1]).toBe(own);
  });

  it("puts a resolved picture back to a reference, in either form", () => {
    const state = {
      messages: [
        { role: "user", content: [{ type: "text", text: "x" }, { type: "image_url", image_url: { url: "data:image/png;base64,QQ==" }, fileId: "a", name: "a.png" }] },
        { role: "user", content: [{ type: "image_url", image_url: { base64: "QQ==", media_type: "image/png" }, fileId: "b", name: "b.png" }] },
        { role: "user", content: [{ type: "image_url", image_url: { base64: "QQ==", media_type: "image/png" } }, { type: "image_url", image_url: { url: "https://x/y.png" } }] },
      ],
    };
    const back = dehydrateImages(state);
    expect(back.messages[0]!.content[1]).toEqual(imageReferencePart("a", "a.png"));
    expect(back.messages[1]!.content[0]).toEqual(imageReferencePart("b", "b.png"));
    // a picture that is not ours (no file id) is not touched
    expect(back.messages[2]!.content[0]).toMatchObject({ image_url: { base64: "QQ==" } });
    expect(back.messages[2]!.content[1]).toMatchObject({ image_url: { url: "https://x/y.png" } });
    expect(state.messages[0]!.content[1]).toMatchObject({ image_url: { url: "data:image/png;base64,QQ==" } });
  });
});

describe("expandViewedImages", () => {
  it("follows a view_image result with a user message carrying the picture", () => {
    const messages = [
      { role: "assistant", content: "", tool_calls: [{ id: "t1" }, { id: "t2" }] },
      { role: "tool", name: SESSION_FILES_VIEW_IMAGE_TOOL, tool_call_id: "t1", content: viewImageToolResult("a", "a.png") },
      { role: "tool", name: "other", tool_call_id: "t2", content: "x" },
      { role: "assistant", content: "ok" },
    ];
    const out = expandViewedImages(messages) as any[];
    expect(out.map((m) => m.role)).toEqual(["assistant", "tool", "tool", "user", "assistant"]);
    expect(out[3].content[0].text).toContain("the image you asked to look at");
    expect(out[3].content.some((p: any) => p.fileId === "a")).toBe(true);
    // nothing to show: the same array comes back
    const plain = [{ role: "tool", name: "other", content: "x" }];
    expect(expandViewedImages(plain)).toBe(plain);
    // a refusal is plain text: nothing to show
    const refused = [{ role: "tool", name: SESSION_FILES_VIEW_IMAGE_TOOL, content: "File is not attached" }];
    expect(expandViewedImages(refused)).toBe(refused);
  });
});

function fakeTurn(images: ImageSource, over: Partial<TurnFiles> = {}): TurnFiles {
  return {
    conversationId: "conv_1",
    cfg: resolveFilesConfig(undefined, { vision: true }, limits),
    list: async () => [],
    find: async () => null,
    text: async () => null,
    bytes: async () => null,
    images,
    viewImageTool: true,
    ...over,
  };
}

describe("withSessionImages", () => {
  function model() {
    const seen: { invoke: unknown[]; stream: unknown[]; bound: unknown[] } = { invoke: [], stream: [], bound: [] };
    const base = {
      modelName: "m",
      invoke: async (messages: unknown[]) => {
        seen.invoke.push(messages);
        return { role: "assistant", content: "ok" };
      },
      stream: async function* (messages: unknown[]) {
        seen.stream.push(messages);
        yield "a";
        yield "b";
      },
      bindTools(tools: unknown[]) {
        return { ...base, boundTo: tools, invoke: async (messages: unknown[]) => { seen.bound.push(messages); return { role: "assistant", content: "bound" }; } };
      },
    };
    return { base, seen };
  }
  const source = imageSource({ a: { name: "a.png", bytes: Buffer.from("AAAA") } });

  it("hands the model bytes where the SDK sent references - invoke, stream and the bound model", async () => {
    const { base, seen } = model();
    const wrapped = withSessionImages(base);
    expect(isSessionImageModel(wrapped)).toBe(true);
    expect(isSessionImageModel(base)).toBe(false);
    expect(wrapped.modelName).toBe("m");

    await runWithTurnFiles(fakeTurn(source), async () => {
      await wrapped.invoke([userWith("a")]);
      const chunks: unknown[] = [];
      for await (const chunk of wrapped.stream([userWith("a")])) chunks.push(chunk);
      expect(chunks).toEqual(["a", "b"]);
      const bound = wrapped.bindTools([{ name: "t" }]) as any;
      expect(isSessionImageModel(bound)).toBe(true);
      expect(bound.boundTo).toEqual([{ name: "t" }]);
      await bound.invoke([userWith("a")]);
    });
    for (const sent of [seen.invoke[0], seen.stream[0], seen.bound[0]] as any[][]) {
      expect(sent[0].content[1]).toMatchObject({ type: "image_url", image_url: { url: expect.stringMatching(/^data:image\/png;base64,/) } });
    }
  });

  it("shows an image the agent asked to look at again", async () => {
    const { base, seen } = model();
    const wrapped = withSessionImages(base);
    await runWithTurnFiles(fakeTurn(source), () =>
      wrapped.invoke([
        { role: "assistant", content: "" },
        { role: "tool", name: SESSION_FILES_VIEW_IMAGE_TOOL, content: viewImageToolResult("a", "a.png") },
      ])
    );
    const sent = seen.invoke[0] as any[];
    expect(sent.at(-1).role).toBe("user");
    expect(sent.at(-1).content.at(-1)).toMatchObject({ type: "image_url", fileId: "a", image_url: { url: expect.stringMatching(/^data:image\/png;base64,/) } });
  });

  it("passes everything through outside a server turn", async () => {
    const { base, seen } = model();
    const wrapped = withSessionImages(base);
    const messages = [userWith("a")];
    await wrapped.invoke(messages);
    expect(seen.invoke[0]).toBe(messages);
  });
});

describe("createImageAwareTokenCounter", () => {
  const base64 = Buffer.alloc(60_000, 7).toString("base64");
  const count = createImageAwareTokenCounter();

  it("bills an image by what a provider charges, not by its length", () => {
    const text = JSON.stringify([{ role: "user", content: [{ type: "text", text: "hi" }, { type: "image_url", image_url: { base64, media_type: "image/png" } }] }]);
    expect(text.length / 4).toBeGreaterThan(15_000);
    expect(count(text)).toBeLessThan(IMAGE_TOKENS + 100);
    expect(count(text)).toBeGreaterThan(IMAGE_TOKENS);
    expect(count(`data:image/png;base64,${base64}`)).toBeLessThan(IMAGE_TOKENS + 20);
  });

  it("counts a reference like an image, and plain text like the SDK does", () => {
    expect(count("session-file://file_1")).toBeGreaterThanOrEqual(IMAGE_TOKENS);
    expect(count("hello world, hello")).toBe(Math.ceil("hello world, hello".length / 4));
    expect(count("")).toBe(0);
  });
});

describe("text extraction", () => {
  const file = (mimeType: string, name = "f") => ({ id: `id_${name}`, name, mimeType, size: 1 });

  afterEach(() => {
    resetToMarkdownLoader();
  });

  it("reads text-like files as UTF-8 and drops a BOM", async () => {
    expect(await defaultExtractText(file("text/plain"), Buffer.from("héllo"))).toBe("héllo");
    expect(await defaultExtractText(file("application/json"), Buffer.from('{"a":1}'))).toBe('{"a":1}');
    expect(await defaultExtractText(file("text/csv"), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("a,b")]))).toBe("a,b");
    expect(await defaultExtractText(file("image/svg+xml"), Buffer.from("<svg/>"))).toBe("<svg/>");
  });

  it("has no text for a picture, a binary or an Office file without the converter", async () => {
    expect(await defaultExtractText(file("image/png"), Buffer.from("x"))).toBeNull();
    expect(await defaultExtractText(file("application/zip"), Buffer.from("PK"))).toBeNull();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(await defaultExtractText(file("application/pdf", "a.pdf"), Buffer.from("%PDF"))).toBeNull();
    warn.mockRestore();
  });

  it("reads an unlabelled file that is plainly text, and not one that is binary", async () => {
    expect(await defaultExtractText(file("application/octet-stream"), Buffer.from("line one\nline two ü"))).toBe("line one\nline two ü");
    expect(await defaultExtractText(file("application/octet-stream"), Buffer.from([1, 2, 0, 3]))).toBeNull();
    // a multi-byte character cut in two by the end of the sample is still text
    expect(await defaultExtractText(file("application/octet-stream"), Buffer.from("é".repeat(5000)))).toBe("é".repeat(5000));
  });

  it("keeps what it read and reads each file once, even when asked twice at the same time", async () => {
    const extractor = createTextExtractor(1_000_000);
    let loads = 0;
    const load = async () => {
      loads++;
      await new Promise((r) => setTimeout(r, 5));
      return Buffer.from("body");
    };
    const f = file("text/plain", "a");
    const [one, two] = await Promise.all([extractor.extract(f, load), extractor.extract(f, load)]);
    expect([one, two]).toEqual(["body", "body"]);
    expect(await extractor.extract(f, load)).toBe("body");
    expect(loads).toBe(1);
  });

  it("forgets the least recently used text when it is full", async () => {
    const extractor = createTextExtractor(2 * 2 * 100); // room for two 100-character texts
    const loads: string[] = [];
    const get = (name: string) =>
      extractor.extract(file("text/plain", name), async () => {
        loads.push(name);
        return Buffer.from("x".repeat(100));
      });
    await get("a");
    await get("b");
    await get("a"); // a is now the newest
    await get("c"); // pushes out b
    loads.length = 0;
    await get("a");
    await get("c");
    expect(loads).toEqual([]);
    await get("b");
    expect(loads).toEqual(["b"]);
  });

  it("does not cache when the cache is off, nor a file whose bytes are gone", async () => {
    const off = createTextExtractor(0);
    let loads = 0;
    const load = async () => (loads++, Buffer.from("t"));
    await off.extract(file("text/plain", "n"), load);
    await off.extract(file("text/plain", "n"), load);
    expect(loads).toBe(2);
    const gone = createTextExtractor(1000);
    expect(await gone.extract(file("text/plain", "g"), async () => null)).toBeNull();
  });

  it("lets the host take a file over, and falls back to the default when it declines", async () => {
    const extractor = createTextExtractor(1000);
    const hook = vi.fn(async (f: { name: string }) => (f.name === "custom" ? "from the hook" : f.name === "none" ? null : undefined));
    const load = async () => Buffer.from("raw text");
    expect(await extractor.extract(file("application/x-custom", "custom"), load, hook)).toBe("from the hook");
    expect(await extractor.extract(file("text/plain", "none"), load, hook)).toBeNull();
    expect(await extractor.extract(file("text/plain", "other"), load, hook)).toBe("raw text");
  });

  it("does not remember a failure", async () => {
    const extractor = createTextExtractor(1000);
    let fail = true;
    const hook = async () => {
      if (fail) throw new Error("converter crashed");
      return "fine";
    };
    await expect(extractor.extract(file("application/pdf", "p"), async () => Buffer.from("x"), hook)).rejects.toThrow("crashed");
    fail = false;
    expect(await extractor.extract(file("application/pdf", "p"), async () => Buffer.from("x"), hook)).toBe("fine");
  });
});

describe("text extraction with @cognipeer/to-markdown", () => {
  it("converts PDF and Office files when the package is there", async () => {
    vi.resetModules();
    vi.doMock("@cognipeer/to-markdown", () => ({
      convertToMarkdown: async (_bytes: Buffer, options: { fileName?: string }) => `# ${options.fileName}\n\nconverted`,
    }));
    const { defaultExtractText: extract, resetToMarkdownLoader: reset } = await import("../src/files/extract.js");
    reset();
    expect(await extract({ id: "1", name: "report.pdf", mimeType: "application/pdf", size: 4 }, Buffer.from("%PDF"))).toBe("# report.pdf\n\nconverted");
    expect(
      await extract(
        { id: "2", name: "sheet.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", size: 4 },
        Buffer.from("PK")
      )
    ).toBe("# sheet.xlsx\n\nconverted");
    vi.doUnmock("@cognipeer/to-markdown");
    vi.resetModules();
  });

  it("takes an object result too", async () => {
    vi.resetModules();
    vi.doMock("@cognipeer/to-markdown", () => ({ convertToMarkdown: async () => ({ markdown: "from an object" }) }));
    const { defaultExtractText: extract, resetToMarkdownLoader: reset } = await import("../src/files/extract.js");
    reset();
    expect(await extract({ id: "1", name: "a.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", size: 4 }, Buffer.from("PK"))).toBe("from an object");
    vi.doUnmock("@cognipeer/to-markdown");
    vi.resetModules();
  });
});

// ----------------------------------------------------------------------------
// Assembly
// ----------------------------------------------------------------------------

function record(id: string, name: string, mimeType: string, size = 10): FileRecord {
  return { id, name, mimeType, size, storageKey: `k_${id}`, conversationId: "conv_1", createdAt: new Date() };
}

function source(files: Record<string, { record: FileRecord; text?: string | null; fail?: boolean }>): AttachmentSource {
  return {
    async find(id) {
      return files[id]?.record ?? null;
    },
    async text(rec) {
      const entry = files[rec.id]!;
      if (entry.fail) throw new Error("boom");
      return entry.text ?? null;
    },
  };
}

const attachment = (rec: FileRecord) => ({ id: rec.id, name: rec.name, mimeType: rec.mimeType, size: rec.size });

describe("assembleAttachments", () => {
  const cfg = (over: Parameters<typeof resolveFilesConfig>[1] = {}) => resolveFilesConfig(undefined, over, limits);
  const doc = record("f1", "a.txt", "text/plain");
  const doc2 = record("f2", 'b "q".md', "text/markdown");
  const img = record("i1", "photo.png", "image/png");

  it("puts the documents in the turn when they fit, naming every attachment first", async () => {
    const out = await assembleAttachments({
      attachments: [attachment(doc), attachment(doc2)],
      source: source({ f1: { record: doc, text: "alpha" }, f2: { record: doc2, text: "beta" } }),
      cfg: cfg(),
      showImages: false,
      canPage: true,
      viewImageTool: false,
    });
    expect(out.mode).toBe("inline");
    expect(out.block).toContain("The person attached 2 files: 2 documents included below.");
    expect(out.block).toContain('<document name="a.txt" id="f1">\nalpha\n</document>');
    expect(out.block).toContain('<document name="b &quot;q&quot;.md" id="f2">\nbeta\n</document>');
    expect(out.block.startsWith('\n\n<attachments source="session-files">')).toBe(true);
    expect(out.warnings).toEqual([]);
  });

  it("sends an agent with the tools to read in pages when the documents are too long together", async () => {
    const out = await assembleAttachments({
      attachments: [attachment(doc), attachment(doc2)],
      source: source({ f1: { record: doc, text: "x".repeat(300) }, f2: { record: doc2, text: "y".repeat(300) } }),
      cfg: cfg({ inlineMaxTokens: 100, readPageChars: 200 }),
      showImages: false,
      canPage: true,
      viewImageTool: false,
    });
    expect(out.mode).toBe("paged");
    expect(out.block).toContain(`2 documents to read with the tools (${SESSION_FILES_LIST_TOOL}, ${SESSION_FILES_READ_TOOL})`);
    expect(out.block).toContain('- "a.txt" (id f1, 2 pages)');
    expect(out.block).not.toContain("xxxx");
  });

  it("gives an agent without the tools the start of the documents and a warning", async () => {
    const out = await assembleAttachments({
      attachments: [attachment(doc), attachment(doc2)],
      source: source({ f1: { record: doc, text: "x".repeat(300) }, f2: { record: doc2, text: "y".repeat(300) } }),
      cfg: cfg({ inlineMaxTokens: 100 }), // room for 400 characters
      showImages: false,
      canPage: false,
      viewImageTool: false,
    });
    expect(out.mode).toBe("truncated");
    expect(out.block).toContain("2 documents included below in part");
    expect(out.block).toContain('<document name="a.txt" id="f1">\n' + "x".repeat(300));
    expect(out.block).toContain(`truncated="true" shown_chars="100" total_chars="300"`);
    expect(out.warnings).toEqual([expect.objectContaining({ code: "file_truncated", count: 1 })]);
  });

  it("says which documents did not fit at all", async () => {
    const out = await assembleAttachments({
      attachments: [attachment(doc), attachment(doc2)],
      source: source({ f1: { record: doc, text: "x".repeat(500) }, f2: { record: doc2, text: "y".repeat(50) } }),
      cfg: cfg({ inlineMaxTokens: 100 }),
      showImages: false,
      canPage: false,
      viewImageTool: false,
    });
    expect(out.block).toContain("is not included: there is no room left");
  });

  it("reports a document it cannot read, and one that is gone, without failing the turn", async () => {
    const out = await assembleAttachments({
      attachments: [attachment(doc), attachment(doc2), attachment(record("f3", "old.txt", "text/plain"))],
      source: source({ f1: { record: doc, fail: true }, f2: { record: doc2, text: null } }),
      cfg: cfg(),
      showImages: false,
      canPage: true,
      viewImageTool: false,
      onError: () => undefined,
    });
    expect(out.mode).toBe("none");
    expect(out.block).toContain("2 documents whose text could not be extracted");
    expect(out.block).toContain("1 file no longer available");
    expect(out.block).toContain('[File "old.txt" (id f3) is no longer available.]');
    expect(out.warnings.map((w) => w.code)).toEqual(["file_unreadable"]);
  });

  it("shows images as a handle plus a reference, and names the picture even with nothing else attached", async () => {
    const out = await assembleAttachments({
      attachments: [attachment(img)],
      source: source({ i1: { record: img } }),
      cfg: cfg({ vision: true }),
      showImages: true,
      canPage: true,
      viewImageTool: false,
    });
    expect(out.images).toHaveLength(1);
    expect(out.block).toContain("The person attached 1 file: 1 image shown below.");
    expect(buildUserTurnContent("what is this?", out)).toEqual([
      { type: "text", text: `what is this?${out.block}` },
      { type: "text", text: '[Attached image: "photo.png" (id i1)]' },
      imageReferencePart("i1", "photo.png"),
    ]);
  });

  it("counts every kind in the first line of a mixed message", async () => {
    const out = await assembleAttachments({
      attachments: [attachment(doc), attachment(doc2), attachment(img)],
      source: source({ f1: { record: doc, text: "x".repeat(400) }, f2: { record: doc2, text: "y".repeat(400) }, i1: { record: img } }),
      cfg: cfg({ vision: true, inlineMaxTokens: 10 }),
      showImages: true,
      canPage: true,
      viewImageTool: false,
    });
    expect(out.block).toContain(
      `The person attached 3 files: 2 documents to read with the tools (${SESSION_FILES_LIST_TOOL}, ${SESSION_FILES_READ_TOOL}), 1 image shown below.`
    );
  });

  it("only mentions an image to an agent that cannot read images", async () => {
    const out = await assembleAttachments({
      attachments: [attachment(img)],
      source: source({ i1: { record: img } }),
      cfg: cfg({ vision: false }),
      showImages: true,
      canPage: true,
      viewImageTool: true,
    });
    expect(out.images).toEqual([]);
    expect(out.block).toContain('[Image "photo.png" (id i1) is attached, but this agent cannot read images.]');
    expect(out.block).toContain("1 image not shown");
    expect(out.warnings).toEqual([expect.objectContaining({ code: "images_not_supported", count: 1 })]);
  });

  it("names an older image instead of showing it, and says how to look again", async () => {
    const out = await assembleAttachments({
      attachments: [attachment(img)],
      source: source({ i1: { record: img } }),
      cfg: cfg({ vision: true }),
      showImages: false,
      canPage: true,
      viewImageTool: true,
    });
    expect(out.images).toEqual([]);
    expect(out.block).toContain(`was attached earlier and is not shown in this request. Use ${SESSION_FILES_VIEW_IMAGE_TOOL}`);
  });

  it("adds nothing for a message without files", async () => {
    const out = await assembleAttachments({ attachments: [], source: source({}), cfg: cfg(), showImages: false, canPage: true, viewImageTool: false });
    expect(out.block).toBe("");
    expect(buildUserTurnContent("plain", out)).toBe("plain");
  });
});

describe("which messages keep showing their images", () => {
  const msg = (id: string, ...mimes: string[]): Message => ({
    id,
    conversationId: "c",
    role: "user",
    content: id,
    files: mimes.map((mimeType, i) => ({ id: `${id}_${i}`, name: "n", mimeType, size: 1 })),
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  it("is the current message and the last `carry` image messages before it", () => {
    const history = [msg("m1", "image/png"), msg("m2", "text/plain"), msg("m3", "image/png"), msg("m4", "image/jpeg"), msg("m5", "image/png")];
    expect([...messagesShowingImages(history, "m5", 2)].sort()).toEqual(["m3", "m4", "m5"].sort().slice().sort());
    expect([...messagesShowingImages(history, "m5", 0)]).toEqual(["m5"]);
    // a text-only follow-up still sees the last image messages
    const followUp = [...history, msg("m6", "text/plain")];
    expect([...messagesShowingImages(followUp, "m6", 2)].sort()).toEqual(["m4", "m5"]);
    expect([...messagesShowingImages(followUp, "m6", 0)]).toEqual([]);
  });

  it("is applied across a history", async () => {
    const make = (id: string) => record(id, `${id}.png`, "image/png");
    const records = { a: make("a"), b: make("b"), c: make("c") };
    const history: Message[] = (["a", "b", "c"] as const).map((id) => ({
      ...msg(`m_${id}`),
      files: [attachment(records[id])],
    }));
    const { byMessage, warnings } = await assembleHistory(history, {
      currentMessageId: "m_c",
      source: source(Object.fromEntries(Object.entries(records).map(([id, rec]) => [id, { record: rec }]))),
      cfg: resolveFilesConfig(undefined, { vision: true, carryRecentImages: 1 }, limits),
      canPage: true,
      viewImageTool: true,
    });
    expect(byMessage.get("m_a")!.images).toEqual([]);
    expect(byMessage.get("m_a")!.block).toContain("is not shown in this request");
    expect(byMessage.get("m_b")!.images).toHaveLength(1);
    expect(byMessage.get("m_c")!.images).toHaveLength(1);
    expect(warnings).toEqual([]);
  });
});

// ----------------------------------------------------------------------------
// Tools
// ----------------------------------------------------------------------------

describe("createSessionFileTools", () => {
  const readme = record("f1", "readme.txt", "text/plain", 5);
  const photo = record("i1", "photo.png", "image/png", 5);
  const texts: Record<string, string | null> = { f1: "0123456789".repeat(5), i1: null };
  const turn = (over: Partial<TurnFiles> = {}) =>
    fakeTurn(imageSource({}), {
      cfg: resolveFilesConfig(undefined, { readPageChars: 20, vision: true }, limits),
      list: async () => [readme, photo],
      find: async (id) => [readme, photo].find((r) => r.id === id) ?? null,
      text: async (rec) => texts[rec.id] ?? null,
      viewImageTool: false,
      ...over,
    });
  const tool = (name: string, options?: { viewImage?: boolean }) => createSessionFileTools(options).find((t) => t.name === name)!;

  it("offers list and read, and view_image only when asked", () => {
    expect(createSessionFileTools().map((t) => t.name)).toEqual([SESSION_FILES_LIST_TOOL, SESSION_FILES_READ_TOOL]);
    expect(createSessionFileTools({ viewImage: true }).map((t) => t.name)).toEqual([
      SESSION_FILES_LIST_TOOL,
      SESSION_FILES_READ_TOOL,
      SESSION_FILES_VIEW_IMAGE_TOOL,
    ]);
    const t = tool(SESSION_FILES_READ_TOOL);
    for (const call of [t.invoke, t.call, t.run, t.func]) expect(typeof call).toBe("function");
    expect(t.schema.safeParse({ fileId: "x" }).success).toBe(true);
    expect(t.schema.safeParse({ fileId: "x", page: 0 }).success).toBe(false);
  });

  it("lists the files of the turn's conversation, and which ones can be read", async () => {
    const result = JSON.parse(await runWithTurnFiles(turn(), () => tool(SESSION_FILES_LIST_TOOL).func({})));
    expect(result).toEqual([
      { fileId: "f1", name: "readme.txt", mimeType: "text/plain", size: 5, readable: true },
      { fileId: "i1", name: "photo.png", mimeType: "image/png", size: 5, readable: false, image: true },
    ]);
    expect(await runWithTurnFiles(turn({ list: async () => [] }), () => tool(SESSION_FILES_LIST_TOOL).func({}))).toBe(
      "No files are attached to this conversation."
    );
  });

  it("reads a file page by page", async () => {
    const read = (args: Record<string, unknown>) => runWithTurnFiles(turn(), () => tool(SESSION_FILES_READ_TOOL).func(args));
    expect(JSON.parse(await read({ fileId: "f1" }))).toEqual({ text: "01234567890123456789", page: 1, pages: 3 });
    expect(JSON.parse(await read({ fileId: "f1", page: 3 }))).toEqual({ text: "0123456789", page: 3, pages: 3 });
    expect(JSON.parse(await read({ fileId: "f1", page: 4 }))).toEqual({ error: "Page 4 is out of range.", pages: 3 });
  });

  it("refuses what is not a readable file of this conversation", async () => {
    const read = (args: Record<string, unknown>, over?: Partial<TurnFiles>) =>
      runWithTurnFiles(turn(over), () => tool(SESSION_FILES_READ_TOOL).func(args));
    expect(await read({ fileId: "elsewhere" })).toContain('File "elsewhere" is not attached to this conversation');
    expect(await read({ fileId: "i1" })).toBe("This file is an image; it has no text to read.");
    expect(await read({ fileId: "i1" }, { viewImageTool: true })).toContain(SESSION_FILES_VIEW_IMAGE_TOOL);
    expect(await read({ fileId: "f1" }, { text: async () => null })).toContain("no readable text");
    const failing = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await read({ fileId: "f1" }, { text: async () => { throw new Error("x"); } })).toBe("The file could not be read right now.");
    failing.mockRestore();
    expect(await read({})).toContain('File "" is not attached');
  });

  it("looks at an image again by asking the model wrapper to show it", async () => {
    const view = (args: Record<string, unknown>) =>
      runWithTurnFiles(turn(), () => tool(SESSION_FILES_VIEW_IMAGE_TOOL, { viewImage: true }).func(args));
    expect(JSON.parse(await view({ fileId: "i1" }))).toMatchObject({ ok: true, fileId: "i1", name: "photo.png" });
    expect(await view({ fileId: "f1" })).toContain("is not an image");
    expect(await view({ fileId: "nope" })).toContain("is not attached");
  });

  it("works only inside a server turn", async () => {
    for (const name of [SESSION_FILES_LIST_TOOL, SESSION_FILES_READ_TOOL]) {
      expect(await tool(name).func({ fileId: "f1" })).toContain("only be read while the server is running a conversation");
    }
  });
});
