/**
 * The storage provider contract: what every `StorageProvider` of this package must do the same way.
 *
 * `runStorageContract(name, open)` registers the suite for one provider; `open()` returns a fresh,
 * isolated store (see providers.ts). The suite shares one store per run and keeps its tests apart
 * with unique ids, so it only asserts on what it created itself.
 *
 * Where a provider legitimately differs (how big a file or a conversation state it can hold) the
 * expectation is derived from `capabilities()`: it either round-trips or is refused with a typed 413.
 */

import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NotFoundError, StorageLimitError, ValidationError } from "../../src/index.js";
import type { StorageProvider } from "../../src/index.js";
import type { OpenedProvider } from "./providers.js";

const MiB = 1024 * 1024;
const uniq = (prefix: string) => `${prefix}-${randomBytes(5).toString("hex")}`;
const jsonRoundTrip = <T>(value: T): T => JSON.parse(JSON.stringify(value));

/** Message / task text the providers have each mangled in some way. */
export const AWKWARD_TEXTS: Record<string, string> = {
  number: "42",
  boolean: "true",
  nullWord: "null",
  object: '{"a":1}',
  quoted: '"quoted"',
  array: "[1,2,3]",
  empty: "",
  spaces: "   ",
  multiline: "line one\nline two\r\n\ttabbed",
  unicode: "héllo wörld 日本語 😀 𝒳",
  nul: "before\u0000after",
  onlyNul: "\u0000",
  escapeChar: "x\u0001y",
  escapeThenZero: "\u00010",
  escapeTwice: "\u0001\u0001",
  nulAndEscape: "\u0001\u0000\u0001\u0000",
  literalBackslashU: "a\\u0000b",
  longText: "lorem ipsum dolor sit amet ".repeat(5000),
};

/** JSON values with the shapes that stores handle differently. */
export function awkwardJson() {
  return {
    nested: { a: { b: { c: [1, 2, { d: null }] } } },
    unicode: AWKWARD_TEXTS.unicode,
    nul: AWKWARD_TEXTS.nul,
    esc: AWKWARD_TEXTS.nulAndEscape,
    looksLikeJson: '{"a":1}',
    numberText: "42",
    empty: "",
    numbers: [0, -1, 1.5, 2 ** 53 - 1, 1e21, -0.0000001, 123456789012],
    flags: [true, false],
    nothing: null,
    $ref: "#/definitions/x",
    "a.b": 1,
    $set: { $inc: 1, "x.y": { $z: 2 } },
    gone: undefined,
    when: new Date(0),
    list: [undefined, "x", null],
  };
}

type Clock = { set(ms: number): void };

/** `Date` frozen at `startMs` (timers stay real) for tests that need rows created "in the same millisecond". */
async function withFrozenDate<T>(startMs: number, fn: (clock: Clock) => Promise<T>): Promise<T> {
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    vi.setSystemTime(startMs);
    return await fn({ set: (ms) => vi.setSystemTime(ms) });
  } finally {
    vi.useRealTimers();
  }
}

/** A time well in the past, so a frozen clock never pushes a provider's sequence into the future. */
const T0 = Date.UTC(2020, 0, 1);

export function runStorageContract(
  name: string,
  open: (options?: { maxFileStorage?: number }) => Promise<OpenedProvider>
) {
  describe(`storage contract: ${name}`, () => {
    let handle: OpenedProvider;
    const s = (): StorageProvider => handle.storage;
    const caps = () => s().capabilities!();

    beforeAll(async () => {
      // maxFileStorage only matters to the in-memory provider: room for the 17 MiB file, not for a 64 MiB one
      handle = await open({ maxFileStorage: 40 * MiB });
    });
    afterAll(async () => {
      await handle?.close();
    });

    const newConversation = (extra: Partial<Parameters<StorageProvider["createConversation"]>[0]> = {}) =>
      s().createConversation({ agentId: uniq("agent"), ...extra });

    // ------------------------------------------------------------------------
    describe("capabilities", () => {
      it("reports what the provider can hold", () => {
        const c = caps();
        expect(c.maxFileBytes).toBeGreaterThan(0);
        expect(c.maxStateBytes).toBeGreaterThan(0);
        expect(typeof c.atomicUpdate).toBe("boolean");
        expect(typeof c.events).toBe("boolean");
        expect(typeof c.leases).toBe("boolean");
        expect(c.fileIndex).toBe(true);
        // every built-in provider can compare-and-set a conversation and find the ones with a lapsed action
        expect(c.atomicUpdate).toBe(true);
        expect(c.actionDeadlines).toBe(true);
      });

      it("is connected, and refuses work once disconnected", async () => {
        const other = await open();
        expect(other.storage.isConnected()).toBe(true);
        await other.storage.disconnect();
        expect(other.storage.isConnected()).toBe(false);
        await expect(other.storage.getConversation("conv_x")).rejects.toThrow(/not connected/i);
        await other.close();
      });
    });

    // ------------------------------------------------------------------------
    describe("conversations", () => {
      it("creates with defaults and reads back the same", async () => {
        const agentId = uniq("agent");
        const created = await s().createConversation({ agentId });
        expect(created).toMatchObject({ agentId, metadata: {}, state: {} });
        expect(created.id).toMatch(/^conv_/);
        expect(created.userId).toBeUndefined();
        expect(created.title).toBeUndefined();
        expect(created.createdAt).toBeInstanceOf(Date);
        expect(created.updatedAt).toBeInstanceOf(Date);

        const fetched = await s().getConversation(created.id);
        expect(fetched).toEqual(created);
        expect(await s().getConversation("conv_does-not-exist")).toBeNull();
      });

      it("keeps every field it was given", async () => {
        const created = await newConversation({
          userId: "user-1",
          title: "A title",
          metadata: { k: "v", n: 1 },
          state: { step: 3 },
        });
        expect(await s().getConversation(created.id)).toMatchObject({
          userId: "user-1",
          title: "A title",
          metadata: { k: "v", n: 1 },
          state: { step: 3 },
        });
      });

      it("update replaces what it is given, leaves the rest, and moves updatedAt", async () => {
        await withFrozenDate(T0, async (clock) => {
          const created = await newConversation({ title: "t", metadata: { a: 1, b: 2 }, state: { x: 1, y: 2 } });
          clock.set(T0 + 5000);
          const onlyTitle = await s().updateConversation(created.id, { title: "renamed" });
          expect(onlyTitle).toMatchObject({ title: "renamed", metadata: { a: 1, b: 2 }, state: { x: 1, y: 2 } });
          expect(onlyTitle.createdAt.getTime()).toBe(T0);
          expect(onlyTitle.updatedAt.getTime()).toBe(T0 + 5000);

          // objects are replaced, not merged
          const replaced = await s().updateConversation(created.id, { metadata: { c: 3 }, state: { z: 9 } });
          expect(replaced.metadata).toEqual({ c: 3 });
          expect(replaced.state).toEqual({ z: 9 });
          expect(await s().getConversation(created.id)).toEqual(replaced);
        });
      });

      it("update of an unknown conversation is a 404", async () => {
        await expect(s().updateConversation("conv_nope", { title: "x" })).rejects.toBeInstanceOf(NotFoundError);
      });

      it("delete removes the conversation and its messages, and ignores an unknown id", async () => {
        const created = await newConversation();
        const message = await s().createMessage({ conversationId: created.id, role: "user", content: "hi" });
        await s().deleteConversation(created.id);
        expect(await s().getConversation(created.id)).toBeNull();
        expect(await s().getMessage(message.id)).toBeNull();
        expect((await s().getMessages(created.id)).total).toBe(0);
        await expect(s().deleteConversation("conv_never-existed")).resolves.toBeUndefined();
      });

      it("lists by agent and user with totals and paging, newest first", async () => {
        const agentId = uniq("agent");
        const mine: string[] = [];
        for (let i = 0; i < 5; i++) {
          mine.push((await s().createConversation({ agentId, userId: i < 3 ? "alice" : "bob" })).id);
          await new Promise((resolve) => setTimeout(resolve, 3));
        }
        const all = await s().getConversations({ agentId, limit: 100 });
        expect(all.total).toBe(5);
        expect(all.data.map((c) => c.id)).toEqual([...mine].reverse());
        expect(all.hasMore).toBe(false);

        const alice = await s().getConversations({ agentId, userId: "alice" });
        expect(alice.total).toBe(3);
        expect(alice.data.every((c) => c.userId === "alice")).toBe(true);

        const page = await s().getConversations({ agentId, limit: 2, offset: 1 });
        expect(page.data.map((c) => c.id)).toEqual([mine[3], mine[2]]);
        expect(page).toMatchObject({ total: 5, limit: 2, offset: 1, hasMore: true });
        const last = await s().getConversations({ agentId, limit: 2, offset: 4 });
        expect(last.data).toHaveLength(1);
        expect(last.hasMore).toBe(false);

        const oldestFirst = await s().getConversations({ agentId, order: "asc", limit: 100 });
        expect(oldestFirst.data.map((c) => c.id)).toEqual(mine);
      });

      it("orders rows created in the same millisecond by insertion", async () => {
        await withFrozenDate(T0, async () => {
          const agentId = uniq("agent");
          const ids: string[] = [];
          for (let i = 0; i < 6; i++) ids.push((await s().createConversation({ agentId })).id);
          expect((await s().getConversations({ agentId, order: "asc", limit: 50 })).data.map((c) => c.id)).toEqual(ids);
          expect((await s().getConversations({ agentId, limit: 50 })).data.map((c) => c.id)).toEqual([...ids].reverse());
          // paging through the tie gives every row exactly once
          const seen: string[] = [];
          for (let offset = 0; offset < 6; offset += 2) {
            seen.push(...(await s().getConversations({ agentId, limit: 2, offset })).data.map((c) => c.id));
          }
          expect(seen).toEqual([...ids].reverse());
        });
      });

      it("can list by last activity", async () => {
        await withFrozenDate(T0, async (clock) => {
          const agentId = uniq("agent");
          const first = await s().createConversation({ agentId });
          clock.set(T0 + 1000);
          const second = await s().createConversation({ agentId });
          clock.set(T0 + 2000);
          await s().createMessage({ conversationId: first.id, role: "user", content: "bump" });
          const byActivity = await s().getConversations({ agentId, orderBy: "updatedAt" });
          expect(byActivity.data.map((c) => c.id)).toEqual([first.id, second.id]);
        });
      });

      it("round-trips awkward metadata and state exactly as JSON", async () => {
        const input = awkwardJson();
        const expected = jsonRoundTrip(input);
        const created = await newConversation({ metadata: input, state: input });
        expect(created.metadata).toEqual(expected);
        const fetched = await s().getConversation(created.id);
        expect(fetched?.metadata).toEqual(expected);
        expect(fetched?.state).toEqual(expected);
        // ...and through an update
        const input2 = { ...awkwardJson(), extra: "2" };
        const updated = await s().updateConversation(created.id, { state: input2, metadata: input2 });
        expect(updated.state).toEqual(jsonRoundTrip(input2));
        expect((await s().getConversation(created.id))?.metadata).toEqual(jsonRoundTrip(input2));
      });

      it("stores no null for a field that was undefined", async () => {
        const created = await newConversation({
          state: { pending: { actions: [{ id: "a1", title: undefined, args: undefined, label: "x" }] } },
        });
        const state = (await s().getConversation(created.id))!.state as any;
        expect(state.pending.actions[0]).toEqual({ id: "a1", label: "x" });
        expect(Object.keys(state.pending.actions[0])).not.toContain("title");
      });

      it("hands out copies: changing a result does not change what is stored", async () => {
        const created = await newConversation({ metadata: { list: [1] }, state: { deep: { v: 1 } } });
        const fetched = (await s().getConversation(created.id))!;
        (fetched.metadata as any).list.push(2);
        (fetched.state as any).deep.v = 99;
        fetched.title = "mutated";
        const again = (await s().getConversation(created.id))!;
        expect(again.metadata).toEqual({ list: [1] });
        expect(again.state).toEqual({ deep: { v: 1 } });
        expect(again.title).toBeUndefined();
      });

      it("holds a state up to its capability and refuses a bigger one with a 413", async () => {
        const created = await newConversation();
        for (const size of [3 * MiB, 11 * MiB, 17 * MiB]) {
          const state = { blob: "x".repeat(size) };
          const bytes = Buffer.byteLength(JSON.stringify(state));
          if (bytes <= caps().maxStateBytes) {
            const updated = await s().updateConversation(created.id, { state });
            expect((updated.state as any).blob.length).toBe(size);
            expect(((await s().getConversation(created.id))!.state as any).blob.length).toBe(size);
          } else {
            await expect(s().updateConversation(created.id, { state })).rejects.toMatchObject({ statusCode: 413 });
            // a refused write changes nothing
            expect(((await s().getConversation(created.id))!.state as any).blob?.length ?? 0).toBeLessThan(size);
          }
        }
      });

      it("takes concurrent creates", async () => {
        const agentId = uniq("agent");
        const made = await Promise.all(Array.from({ length: 20 }, () => s().createConversation({ agentId })));
        expect(new Set(made.map((c) => c.id)).size).toBe(20);
        expect((await s().getConversations({ agentId, limit: 100 })).total).toBe(20);
      });

      it("refuses an over-long title with a 400 where the store has a limit, and holds a long one elsewhere", async () => {
        const title = "t".repeat(501);
        try {
          const created = await newConversation({ title });
          expect((await s().getConversation(created.id))!.title).toBe(title);
        } catch (error) {
          expect(error).toBeInstanceOf(ValidationError);
          expect((error as ValidationError).statusCode).toBe(400);
        }
      });
    });

    // ------------------------------------------------------------------------
    describe("messages", () => {
      it("stores a message with its defaults and reads it back", async () => {
        const conv = await newConversation();
        const created = await s().createMessage({ conversationId: conv.id, role: "user", content: "hello" });
        expect(created.id).toMatch(/^msg_/);
        expect(created).toMatchObject({ conversationId: conv.id, role: "user", content: "hello", metadata: {} });
        expect(created.files).toBeUndefined();
        expect(created.name).toBeUndefined();
        expect(created.toolCalls).toBeUndefined();
        expect(created.toolCallId).toBeUndefined();
        expect(await s().getMessage(created.id)).toEqual(created);
        expect(await s().getMessage("msg_nope")).toBeNull();
      });

      it("keeps tool calls, names, files, parts and metadata", async () => {
        const conv = await newConversation();
        const file = { id: "file_1", name: "a.txt", mimeType: "text/plain", size: 3 };
        const assistant = await s().createMessage({
          conversationId: conv.id,
          role: "assistant",
          content: [
            { type: "text", text: "see" },
            { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
          ],
          toolCalls: [{ id: "call_1", name: "search", arguments: '{"q":"x"}' }],
          files: [file],
          metadata: { stopReason: "end_turn", nested: { ok: true } },
        });
        const tool = await s().createMessage({
          conversationId: conv.id,
          role: "tool",
          content: "result",
          toolCallId: "call_1",
          name: "search",
        });
        expect(await s().getMessage(assistant.id)).toEqual(assistant);
        expect(assistant.toolCalls).toEqual([{ id: "call_1", name: "search", arguments: '{"q":"x"}' }]);
        expect(assistant.files).toEqual([file]);
        expect(assistant.content).toEqual([
          { type: "text", text: "see" },
          { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
        ]);
        expect(await s().getMessage(tool.id)).toMatchObject({ toolCallId: "call_1", name: "search", content: "result" });
      });

      it("reads empty file lists as no files", async () => {
        const conv = await newConversation();
        const created = await s().createMessage({ conversationId: conv.id, role: "user", content: "x", files: [] });
        expect(created.files).toBeUndefined();
        expect((await s().getMessage(created.id))!.files).toBeUndefined();
        expect((await s().getMessages(conv.id)).data[0]!.files).toBeUndefined();
      });

      for (const [label, text] of Object.entries(AWKWARD_TEXTS)) {
        it(`stores the text exactly: ${label}`, async () => {
          const conv = await newConversation();
          const created = await s().createMessage({ conversationId: conv.id, role: "user", content: text });
          expect(created.content).toBe(text);
          const fetched = await s().getMessage(created.id);
          expect(typeof fetched!.content).toBe("string");
          expect(fetched!.content).toBe(text);
          expect((await s().getMessages(conv.id)).data[0]!.content).toBe(text);
        });
      }

      it("stores awkward JSON in tool calls, files and metadata", async () => {
        const conv = await newConversation();
        const meta = awkwardJson();
        const created = await s().createMessage({
          conversationId: conv.id,
          role: "assistant",
          content: [{ type: "text", text: AWKWARD_TEXTS.nul }],
          metadata: meta,
        });
        const fetched = await s().getMessage(created.id);
        expect(fetched!.metadata).toEqual(jsonRoundTrip(meta));
        expect(fetched!.content).toEqual([{ type: "text", text: AWKWARD_TEXTS.nul }]);
      });

      it("orders by time, and rows created in the same millisecond by insertion", async () => {
        await withFrozenDate(T0, async () => {
          const conv = await newConversation();
          const ids: string[] = [];
          for (let i = 0; i < 8; i++) {
            ids.push((await s().createMessage({ conversationId: conv.id, role: "user", content: `m${i}` })).id);
          }
          expect((await s().getMessages(conv.id)).data.map((m) => m.id)).toEqual(ids);
          expect((await s().getMessages(conv.id, { order: "desc" })).data.map((m) => m.id)).toEqual([...ids].reverse());
        });
      });

      it("keeps a stable order for messages written in parallel", async () => {
        await withFrozenDate(T0, async () => {
          const conv = await newConversation();
          const made = await Promise.all(
            Array.from({ length: 12 }, (_, i) => s().createMessage({ conversationId: conv.id, role: "user", content: `p${i}` }))
          );
          const asc = (await s().getMessages(conv.id)).data.map((m) => m.id);
          const desc = (await s().getMessages(conv.id, { order: "desc" })).data.map((m) => m.id);
          expect(new Set(asc)).toEqual(new Set(made.map((m) => m.id)));
          expect(asc).toHaveLength(12);
          expect(desc).toEqual([...asc].reverse());
        });
      });

      it("pages through more than 100 messages", async () => {
        const conv = await newConversation();
        const ids: string[] = [];
        for (let i = 0; i < 250; i++) {
          ids.push((await s().createMessage({ conversationId: conv.id, role: "user", content: `m${i}` })).id);
        }
        const first = await s().getMessages(conv.id);
        expect(first.data).toHaveLength(100);
        expect(first).toMatchObject({ total: 250, limit: 100, offset: 0, hasMore: true });

        const pages: string[] = [];
        for (let offset = 0; ; offset += 100) {
          const page = await s().getMessages(conv.id, { limit: 100, offset });
          pages.push(...page.data.map((m) => m.id));
          if (!page.hasMore) break;
        }
        expect(pages).toEqual(ids);

        const everything = await s().getMessages(conv.id, { limit: 1000 });
        expect(everything.data.map((m) => m.id)).toEqual(ids);
        expect(everything.hasMore).toBe(false);

        const newestFirst = await s().getMessages(conv.id, { order: "desc", limit: 3 });
        expect(newestFirst.data.map((m) => m.id)).toEqual([ids[249], ids[248], ids[247]]);
        expect((await s().getMessages(conv.id, { limit: 100, offset: 200 })).data).toHaveLength(50);
      });

      it("pages around a message with before / after", async () => {
        const conv = await newConversation();
        const ids: string[] = [];
        for (let i = 0; i < 30; i++) {
          ids.push((await s().createMessage({ conversationId: conv.id, role: "user", content: `m${i}` })).id);
        }
        const before = await s().getMessages(conv.id, { before: ids[10], order: "desc", limit: 4 });
        expect(before.data.map((m) => m.id)).toEqual([ids[9], ids[8], ids[7], ids[6]]);
        expect(before).toMatchObject({ total: 10, hasMore: true });

        const beforeAsc = await s().getMessages(conv.id, { before: ids[10], limit: 100 });
        expect(beforeAsc.data.map((m) => m.id)).toEqual(ids.slice(0, 10));
        expect(beforeAsc.hasMore).toBe(false);

        const after = await s().getMessages(conv.id, { after: ids[10], limit: 5 });
        expect(after.data.map((m) => m.id)).toEqual(ids.slice(11, 16));
        expect(after).toMatchObject({ total: 19, hasMore: true });

        expect((await s().getMessages(conv.id, { before: ids[0] })).data).toEqual([]);
        expect((await s().getMessages(conv.id, { after: ids[29] })).data).toEqual([]);

        // the same cursor semantics inside one millisecond
        await withFrozenDate(T0, async () => {
          const tied = await newConversation();
          const tiedIds: string[] = [];
          for (let i = 0; i < 6; i++) {
            tiedIds.push((await s().createMessage({ conversationId: tied.id, role: "user", content: `t${i}` })).id);
          }
          expect((await s().getMessages(tied.id, { before: tiedIds[3] })).data.map((m) => m.id)).toEqual(tiedIds.slice(0, 3));
          expect((await s().getMessages(tied.id, { after: tiedIds[3] })).data.map((m) => m.id)).toEqual(tiedIds.slice(4));
        });
      });

      it("refuses a cursor that is not a message of the conversation, and both cursors at once", async () => {
        const conv = await newConversation();
        const other = await newConversation();
        const mine = await s().createMessage({ conversationId: conv.id, role: "user", content: "a" });
        const theirs = await s().createMessage({ conversationId: other.id, role: "user", content: "b" });
        await expect(s().getMessages(conv.id, { before: "msg_nope" })).rejects.toBeInstanceOf(NotFoundError);
        await expect(s().getMessages(conv.id, { after: theirs.id })).rejects.toBeInstanceOf(NotFoundError);
        await expect(s().getMessages(conv.id, { before: mine.id, after: mine.id })).rejects.toBeInstanceOf(ValidationError);
      });

      it("refuses a message for a conversation that does not exist, and stores nothing", async () => {
        await expect(
          s().createMessage({ conversationId: "conv_missing", role: "user", content: "x" })
        ).rejects.toMatchObject({ statusCode: 404 });
        expect((await s().getMessages("conv_missing")).total).toBe(0);
      });

      it("counts a new message as activity on the conversation", async () => {
        await withFrozenDate(T0, async (clock) => {
          const conv = await newConversation();
          clock.set(T0 + 7000);
          const message = await s().createMessage({ conversationId: conv.id, role: "user", content: "x" });
          const after = (await s().getConversation(conv.id))!;
          expect(after.createdAt.getTime()).toBe(T0);
          expect(after.updatedAt.getTime()).toBe(T0 + 7000);
          expect(message.createdAt.getTime()).toBe(T0 + 7000);
        });
      });

      it("deleting a message keeps its files with the conversation", async () => {
        const conv = await newConversation();
        const message = await s().createMessage({ conversationId: conv.id, role: "user", content: "see file" });
        const file = await s().saveFile({
          name: "a.txt",
          mimeType: "text/plain",
          content: Buffer.from("hello"),
          conversationId: conv.id,
          messageId: message.id,
        });
        await s().deleteMessage(message.id);
        expect(await s().getMessage(message.id)).toBeNull();
        const kept = await s().getFile(file.id);
        expect(kept).toMatchObject({ id: file.id, conversationId: conv.id });
        expect(kept!.messageId).toBeUndefined();
        expect((await s().getFileContent(file.id))!.toString()).toBe("hello");
        await expect(s().deleteMessage("msg_never-existed")).resolves.toBeUndefined();
      });

      it("holds a large message, or refuses it with a 413", async () => {
        const conv = await newConversation();
        for (const size of [1 * MiB, 16.5 * MiB, 17 * MiB]) {
          const content = "y".repeat(size);
          try {
            const created = await s().createMessage({ conversationId: conv.id, role: "assistant", content });
            expect(((await s().getMessage(created.id))!.content as string).length).toBe(size);
          } catch (error) {
            expect(error).toBeInstanceOf(StorageLimitError);
            expect((error as StorageLimitError).statusCode).toBe(413);
          }
        }
      });

      it("refuses an over-long message name with a 400 where the store has a limit", async () => {
        const conv = await newConversation();
        try {
          const created = await s().createMessage({ conversationId: conv.id, role: "tool", content: "x", name: "n".repeat(256) });
          expect((await s().getMessage(created.id))!.name).toBe("n".repeat(256));
        } catch (error) {
          expect((error as ValidationError).statusCode).toBe(400);
        }
      });
    });

    // ------------------------------------------------------------------------
    describe("files", () => {
      const sizes = [1, 1 * MiB, 11 * MiB, 17 * MiB];
      for (const size of sizes) {
        it(`stores ${size} bytes and returns a Buffer with the same bytes`, async () => {
          const content = randomBytes(size);
          const expected = Buffer.from(content);
          const file = await s().saveFile({ name: "blob.bin", mimeType: "application/octet-stream", content });
          expect(file.id).toMatch(/^file_/);
          expect(file).toMatchObject({ name: "blob.bin", mimeType: "application/octet-stream", size, metadata: {} });
          expect(file.storageKey.length).toBeGreaterThan(0);
          expect(file.createdAt).toBeInstanceOf(Date);
          content.fill(0); // what is stored is the buffer as it was at save time, not shared with the caller

          const read = await s().getFileContent(file.id);
          expect(Buffer.isBuffer(read)).toBe(true);
          expect(read!.length).toBe(size);
          expect(read!.equals(expected)).toBe(true);
          expect(await s().getFile(file.id)).toEqual(file);
          await s().deleteFile(file.id);
        });
      }

      it("stores an empty file", async () => {
        const file = await s().saveFile({ name: "empty", mimeType: "text/plain", content: Buffer.alloc(0) });
        expect(file.size).toBe(0);
        const read = await s().getFileContent(file.id);
        expect(Buffer.isBuffer(read)).toBe(true);
        expect(read!.length).toBe(0);
      });

      it("keeps every byte value", async () => {
        const content = Buffer.from(Array.from({ length: 1024 }, (_, i) => i % 256));
        const file = await s().saveFile({ name: "bytes", mimeType: "application/octet-stream", content });
        expect((await s().getFileContent(file.id))!.equals(content)).toBe(true);
      });

      it("keeps the owner, metadata and awkward names", async () => {
        const conv = await newConversation();
        const file = await s().saveFile({
          name: `na"me ${AWKWARD_TEXTS.unicode}.txt`,
          mimeType: "text/plain; charset=utf-8",
          content: Buffer.from("abc"),
          conversationId: conv.id,
          metadata: awkwardJson(),
        });
        const fetched = await s().getFile(file.id);
        expect(fetched).toMatchObject({ name: `na"me ${AWKWARD_TEXTS.unicode}.txt`, conversationId: conv.id });
        expect(fetched!.metadata).toEqual(jsonRoundTrip(awkwardJson()));
      });

      it("answers null for a file that does not exist, and ignores deleting it", async () => {
        expect(await s().getFile("file_nope")).toBeNull();
        expect(await s().getFileContent("file_nope")).toBeNull();
        await expect(s().deleteFile("file_nope")).resolves.toBeUndefined();
      });

      it("deleting a file removes its content", async () => {
        const before = await handle.blobCount();
        const file = await s().saveFile({ name: "gone.txt", mimeType: "text/plain", content: Buffer.from("bye") });
        expect(await handle.blobCount()).toBe(before + 1);
        await s().deleteFile(file.id);
        expect(await s().getFile(file.id)).toBeNull();
        expect(await s().getFileContent(file.id)).toBeNull();
        expect(await handle.blobCount()).toBe(before);
      });

      it("refuses a file for a conversation that does not exist and leaves no content behind", async () => {
        const before = await handle.blobCount();
        await expect(
          s().saveFile({ name: "x.txt", mimeType: "text/plain", content: Buffer.from("x"), conversationId: "conv_missing" })
        ).rejects.toMatchObject({ statusCode: 404 });
        expect(await handle.blobCount()).toBe(before);
      });

      it("refuses a file for a message that does not exist, and for another conversation's message", async () => {
        const before = await handle.blobCount();
        const conv = await newConversation();
        const other = await newConversation();
        const message = await s().createMessage({ conversationId: other.id, role: "user", content: "x" });
        await expect(
          s().saveFile({ name: "x", mimeType: "text/plain", content: Buffer.from("x"), messageId: "msg_missing" })
        ).rejects.toBeInstanceOf(NotFoundError);
        await expect(
          s().saveFile({ name: "x", mimeType: "text/plain", content: Buffer.from("x"), conversationId: conv.id, messageId: message.id })
        ).rejects.toBeInstanceOf(ValidationError);
        expect(await handle.blobCount()).toBe(before);
      });

      it("files a message's attachment under that message's conversation", async () => {
        const conv = await newConversation();
        const message = await s().createMessage({ conversationId: conv.id, role: "user", content: "x" });
        const file = await s().saveFile({ name: "m.txt", mimeType: "text/plain", content: Buffer.from("m"), messageId: message.id });
        expect(file).toMatchObject({ conversationId: conv.id, messageId: message.id });
        await s().deleteConversation(conv.id);
        expect(await s().getFile(file.id)).toBeNull();
      });

      it("deleting a conversation deletes its files and their content, and only those", async () => {
        const conv = await newConversation();
        const other = await newConversation();
        const message = await s().createMessage({ conversationId: conv.id, role: "user", content: "see" });
        const before = await handle.blobCount();
        const loose = await s().saveFile({ name: "a", mimeType: "text/plain", content: Buffer.from("a"), conversationId: conv.id });
        const attached = await s().saveFile({
          name: "b",
          mimeType: "text/plain",
          content: Buffer.from("b"),
          conversationId: conv.id,
          messageId: message.id,
        });
        const kept = await s().saveFile({ name: "c", mimeType: "text/plain", content: Buffer.from("c"), conversationId: other.id });
        const nobody = await s().saveFile({ name: "d", mimeType: "text/plain", content: Buffer.from("d") });
        expect(await handle.blobCount()).toBe(before + 4);

        await s().deleteConversation(conv.id);
        expect(await s().getFile(loose.id)).toBeNull();
        expect(await s().getFile(attached.id)).toBeNull();
        expect(await s().getFileContent(loose.id)).toBeNull();
        expect(await handle.blobCount()).toBe(before + 2);
        expect((await s().getFileContent(kept.id))!.toString()).toBe("c");
        expect((await s().getFileContent(nobody.id))!.toString()).toBe("d");
      });

      it("keeps who uploaded a file, for which agent, and when it expires - and nothing for a file saved without them", async () => {
        const conv = await newConversation();
        const expiresAt = new Date(Date.now() + 86_400_000);
        const owned = await s().saveFile({
          name: "owned.txt",
          mimeType: "text/plain",
          content: Buffer.from("o"),
          conversationId: conv.id,
          userId: "user-1",
          agentId: conv.agentId,
          expiresAt,
        });
        expect(owned).toMatchObject({ userId: "user-1", agentId: conv.agentId });
        expect(owned.expiresAt!.getTime()).toBe(expiresAt.getTime());
        const read = await s().getFile(owned.id);
        expect(read).toMatchObject({ userId: "user-1", agentId: conv.agentId });
        expect(read!.expiresAt).toBeInstanceOf(Date);
        expect(read!.expiresAt!.getTime()).toBe(expiresAt.getTime());

        const plain = await s().saveFile({ name: "plain.txt", mimeType: "text/plain", content: Buffer.from("p") });
        for (const record of [plain, (await s().getFile(plain.id))!]) {
          expect(record.userId).toBeUndefined();
          expect(record.agentId).toBeUndefined();
          expect(record.expiresAt).toBeUndefined();
        }
      });

      it("refuses an expiry that is not a date, and an over-long owner where the store has a limit", async () => {
        await expect(
          s().saveFile({ name: "x", mimeType: "text/plain", content: Buffer.from("x"), expiresAt: new Date("nope") })
        ).rejects.toBeInstanceOf(ValidationError);
        try {
          const file = await s().saveFile({ name: "x", mimeType: "text/plain", content: Buffer.from("x"), userId: "u".repeat(256) });
          await s().deleteFile(file.id);
        } catch (error) {
          expect((error as ValidationError).statusCode).toBe(400);
        }
      });

      it("lists a conversation's files oldest first, in insertion order within a millisecond, and only that conversation's", async () => {
        await withFrozenDate(T0, async () => {
          const conv = await newConversation();
          const other = await newConversation();
          const ids: string[] = [];
          for (let i = 0; i < 6; i++) {
            ids.push((await s().saveFile({ name: `f${i}.txt`, mimeType: "text/plain", content: Buffer.from(`${i}`), conversationId: conv.id })).id);
          }
          await s().saveFile({ name: "elsewhere.txt", mimeType: "text/plain", content: Buffer.from("e"), conversationId: other.id });
          await s().saveFile({ name: "loose.txt", mimeType: "text/plain", content: Buffer.from("l") });

          const all = await s().listFiles!({ conversationId: conv.id });
          expect(all.data.map((f) => f.id)).toEqual(ids);
          expect(all).toMatchObject({ total: 6, offset: 0, hasMore: false });
          expect((await s().listFiles!({ conversationId: conv.id, order: "desc" })).data.map((f) => f.id)).toEqual([...ids].reverse());

          const page = await s().listFiles!({ conversationId: conv.id, limit: 2, offset: 2 });
          expect(page.data.map((f) => f.id)).toEqual(ids.slice(2, 4));
          expect(page).toMatchObject({ total: 6, limit: 2, offset: 2, hasMore: true });
          expect((await s().listFiles!({ conversationId: other.id })).total).toBe(1);
        });
      });

      it("lists nothing for a conversation without files or that does not exist, and forgets deleted files", async () => {
        const conv = await newConversation();
        expect(await s().listFiles!({ conversationId: conv.id })).toMatchObject({ data: [], total: 0, hasMore: false });
        expect(await s().listFiles!({ conversationId: "conv_nope" })).toMatchObject({ data: [], total: 0 });
        const a = await s().saveFile({ name: "a", mimeType: "text/plain", content: Buffer.from("a"), conversationId: conv.id });
        const b = await s().saveFile({ name: "b", mimeType: "text/plain", content: Buffer.from("b"), conversationId: conv.id });
        await s().deleteFile(a.id);
        expect((await s().listFiles!({ conversationId: conv.id })).data.map((f) => f.id)).toEqual([b.id]);
        await s().deleteConversation(conv.id);
        expect((await s().listFiles!({ conversationId: conv.id })).total).toBe(0);
      });

      it("refuses to list without a conversation", async () => {
        await expect(s().listFiles!({ conversationId: "" })).rejects.toBeInstanceOf(ValidationError);
      });

      it("keeps the owner and expiry of listed files", async () => {
        const conv = await newConversation();
        const expiresAt = new Date(Date.now() + 5_000_000);
        await s().saveFile({ name: "a", mimeType: "text/plain", content: Buffer.from("a"), conversationId: conv.id, userId: "u-9", expiresAt });
        const [listed] = (await s().listFiles!({ conversationId: conv.id })).data;
        expect(listed).toMatchObject({ userId: "u-9" });
        expect(listed!.expiresAt!.getTime()).toBe(expiresAt.getTime());
      });

      it("purges the files that expired - record and content - and leaves the rest", async () => {
        const conv = await newConversation();
        const before = await handle.blobCount();
        const now = Date.now();
        const old = await s().saveFile({ name: "old", mimeType: "text/plain", content: Buffer.from("o"), conversationId: conv.id, expiresAt: new Date(now - 60_000) });
        const older = await s().saveFile({ name: "older", mimeType: "text/plain", content: Buffer.from("oo"), expiresAt: new Date(now - 120_000) });
        const fresh = await s().saveFile({ name: "fresh", mimeType: "text/plain", content: Buffer.from("f"), expiresAt: new Date(now + 3_600_000) });
        const forever = await s().saveFile({ name: "forever", mimeType: "text/plain", content: Buffer.from("x"), conversationId: conv.id });
        expect(await handle.blobCount()).toBe(before + 4);

        const purged = await s().purgeExpiredFiles!({ before: new Date(now) });
        expect(purged).toBeGreaterThanOrEqual(2);
        expect(await s().getFile(old.id)).toBeNull();
        expect(await s().getFile(older.id)).toBeNull();
        expect(await s().getFileContent(old.id)).toBeNull();
        expect(await s().getFile(fresh.id)).not.toBeNull();
        expect(await s().getFile(forever.id)).not.toBeNull();
        expect((await s().listFiles!({ conversationId: conv.id })).data.map((f) => f.id)).toEqual([forever.id]);
        expect(await handle.blobCount()).toBe(before + 2);
        // nothing is due any more
        expect(await s().purgeExpiredFiles!({ before: new Date(now) })).toBe(0);
      });

      it("purges at most `limit` files per call, the earliest expiry first", async () => {
        const now = Date.now();
        const mine: string[] = [];
        for (let i = 0; i < 4; i++) {
          mine.push((await s().saveFile({
            name: `p${i}`,
            mimeType: "text/plain",
            content: Buffer.from("p"),
            expiresAt: new Date(now - (4 - i) * 1_000_000_000),
          })).id);
        }
        // Everything the suite left that has expired goes too, but only the oldest `limit` per call
        const first = await s().purgeExpiredFiles!({ before: new Date(now), limit: 1 });
        expect(first).toBe(1);
        let left = 0;
        for (const id of mine) if (await s().getFile(id)) left++;
        expect(left).toBeLessThanOrEqual(4);
        let guard = 0;
        while ((await s().purgeExpiredFiles!({ before: new Date(now), limit: 2 })) > 0 && guard++ < 20);
        for (const id of mine) expect(await s().getFile(id)).toBeNull();
      });

      it("refuses to purge without a valid cut-off", async () => {
        await expect(s().purgeExpiredFiles!({ before: new Date("nope") })).rejects.toBeInstanceOf(ValidationError);
      });

      it("refuses a file over its capability with a 413 and stores nothing", async () => {
        const limit = caps().maxFileBytes;
        if (limit > 64 * MiB) return; // too large to allocate here; the in-memory provider covers the path
        const before = await handle.blobCount();
        await expect(
          s().saveFile({ name: "huge", mimeType: "application/octet-stream", content: Buffer.alloc(limit + 1) })
        ).rejects.toMatchObject({ statusCode: 413, code: "STORAGE_LIMIT_EXCEEDED" });
        expect(await handle.blobCount()).toBe(before);
      });

      it("refuses an over-long file name or type with a 400 where the store has a limit", async () => {
        for (const extra of [{ name: "n".repeat(501) }, { mimeType: "m".repeat(256) }]) {
          try {
            const file = await s().saveFile({
              name: "ok.txt",
              mimeType: "text/plain",
              content: Buffer.from("x"),
              ...extra,
            });
            await s().deleteFile(file.id);
          } catch (error) {
            expect((error as ValidationError).statusCode).toBe(400);
          }
        }
      });
    });

    // ------------------------------------------------------------------------
    describe("tasks", () => {
      const newTask = (extra: Partial<Parameters<StorageProvider["createTask"]>[0]> = {}) =>
        s().createTask({ agentId: uniq("agent"), input: "do it", ...extra });

      it("creates with defaults and reads back the same", async () => {
        const created = await newTask();
        expect(created.id).toMatch(/^task_/);
        expect(created).toMatchObject({ status: "pending", input: "do it", comments: [], metadata: {} });
        expect(created.files).toBeUndefined();
        expect(created.userId).toBeUndefined();
        expect(created.callbackUrl).toBeUndefined();
        expect(created.error).toBeUndefined();
        expect(created.startedAt).toBeUndefined();
        expect(await s().getTask(created.id)).toEqual(created);
        expect(await s().getTask("task_nope")).toBeNull();
      });

      it("keeps files, owner, callback and metadata", async () => {
        const file = { id: "file_1", name: "a.txt", mimeType: "text/plain", size: 3 };
        const created = await newTask({ userId: "u", callbackUrl: "https://example.com/hook", files: [file], metadata: awkwardJson() });
        const fetched = await s().getTask(created.id);
        expect(fetched).toMatchObject({ userId: "u", callbackUrl: "https://example.com/hook", files: [file] });
        expect(fetched!.metadata).toEqual(jsonRoundTrip(awkwardJson()));
      });

      it("keeps task text exactly", async () => {
        for (const text of [AWKWARD_TEXTS.nul, AWKWARD_TEXTS.nulAndEscape, AWKWARD_TEXTS.unicode, AWKWARD_TEXTS.object]) {
          const created = await newTask({ input: text });
          expect((await s().getTask(created.id))!.input).toBe(text);
          const failed = await s().updateTask(created.id, { status: "failed", error: text });
          expect(failed.error).toBe(text);
        }
      });

      it("stores comments (with real dates) and replaces them on update", async () => {
        const created = await newTask();
        const first = { id: "c1", taskId: created.id, role: "user" as const, content: "please also X", createdAt: new Date(T0), metadata: { a: 1 } };
        const second = { id: "c2", taskId: created.id, role: "agent" as const, content: AWKWARD_TEXTS.nul, createdAt: new Date(T0 + 1000) };
        const updated = await s().updateTask(created.id, { comments: [first, second] });
        expect(updated.comments).toHaveLength(2);
        expect(updated.comments![0]).toEqual(first);
        expect(updated.comments![1]!.createdAt).toBeInstanceOf(Date);
        expect(updated.comments![1]!.content).toBe(AWKWARD_TEXTS.nul);

        const fetched = await s().getTask(created.id);
        expect(fetched!.comments).toEqual([first, second]);
        // untouched by an update that does not mention them
        expect((await s().updateTask(created.id, { status: "running" })).comments).toHaveLength(2);
        expect((await s().updateTask(created.id, { comments: [] })).comments).toEqual([]);
      });

      it("updates status, times and errors", async () => {
        const created = await newTask();
        const started = new Date(T0 + 10);
        const done = new Date(T0 + 20);
        const running = await s().updateTask(created.id, { status: "running", startedAt: started });
        expect(running).toMatchObject({ status: "running" });
        expect(running.startedAt!.getTime()).toBe(T0 + 10);
        const failed = await s().updateTask(created.id, { status: "failed", completedAt: done, error: "boom", metadata: { why: "x" } });
        expect(failed).toMatchObject({ status: "failed", error: "boom", metadata: { why: "x" } });
        expect(failed.completedAt!.getTime()).toBe(T0 + 20);
        expect(failed.startedAt!.getTime()).toBe(T0 + 10);
      });

      it("accepts an update that changes nothing", async () => {
        await withFrozenDate(T0, async () => {
          const created = await newTask();
          await s().updateTask(created.id, { status: "running" });
          await expect(s().updateTask(created.id, { status: "running" })).resolves.toMatchObject({ status: "running" });
        });
      });

      it("update of an unknown task is a 404", async () => {
        await expect(s().updateTask("task_nope", { status: "running" })).rejects.toBeInstanceOf(NotFoundError);
      });

      it("lists by agent, user and status with totals, paging and a stable order", async () => {
        const agentId = uniq("agent");
        await withFrozenDate(T0, async () => {
          const ids: string[] = [];
          for (let i = 0; i < 5; i++) {
            ids.push((await s().createTask({ agentId, userId: i % 2 ? "bob" : "alice", input: `t${i}` })).id);
          }
          await s().updateTask(ids[1]!, { status: "completed" });
          await s().updateTask(ids[3]!, { status: "completed" });

          const all = await s().getTasks({ agentId, limit: 50 });
          expect(all.total).toBe(5);
          expect(all.data.map((t) => t.id)).toEqual([...ids].reverse());
          expect((await s().getTasks({ agentId, order: "asc", limit: 50 })).data.map((t) => t.id)).toEqual(ids);
          expect((await s().getTasks({ agentId, status: "completed" })).total).toBe(2);
          expect((await s().getTasks({ agentId, userId: "alice" })).total).toBe(3);
          const page = await s().getTasks({ agentId, limit: 2, offset: 2 });
          expect(page.data.map((t) => t.id)).toEqual([ids[2], ids[1]]);
          expect(page).toMatchObject({ total: 5, hasMore: true });
        });
      });

      it("keeps one result per task: the second replaces the first", async () => {
        const task = await newTask();
        expect(await s().getTaskResult(task.id)).toBeNull();

        // the waiting_for_input cycle: a partial result, then the final one
        const partial = await s().createTaskResult({ taskId: task.id, content: "need more input" });
        expect(partial.id).toMatch(/^taskres_/);
        const final = await s().createTaskResult({
          taskId: task.id,
          content: AWKWARD_TEXTS.nul,
          files: [{ id: "file_1", name: "out.txt", mimeType: "text/plain", size: 3 }],
          metadata: { done: true },
          usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
        });
        expect(final.id).toBe(partial.id);

        const fetched = await s().getTaskResult(task.id);
        expect(fetched).toEqual(final);
        expect(fetched).toMatchObject({
          taskId: task.id,
          content: AWKWARD_TEXTS.nul,
          metadata: { done: true },
          usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
        });
        expect(fetched!.files).toHaveLength(1);
      });

      it("keeps a result's defaults", async () => {
        const task = await newTask();
        const result = await s().createTaskResult({ taskId: task.id, content: "ok" });
        expect(result.files).toBeUndefined();
        expect(result.usage).toBeUndefined();
        expect(result.metadata).toEqual({});
        expect(await s().getTaskResult(task.id)).toEqual(result);
      });

      it("refuses a result for a task that does not exist", async () => {
        await expect(s().createTaskResult({ taskId: "task_nope", content: "x" })).rejects.toBeInstanceOf(NotFoundError);
      });

      it("deleting a task deletes its result", async () => {
        const task = await newTask();
        await s().createTaskResult({ taskId: task.id, content: "x" });
        await s().deleteTask(task.id);
        expect(await s().getTask(task.id)).toBeNull();
        expect(await s().getTaskResult(task.id)).toBeNull();
        await expect(s().deleteTask("task_never-existed")).resolves.toBeUndefined();
      });

      it("refuses an over-long task field with a 400 where the store has a limit", async () => {
        try {
          const created = await newTask({ callbackUrl: `https://example.com/${"p".repeat(2000)}` });
          expect((await s().getTask(created.id))!.callbackUrl).toContain("https://example.com/");
        } catch (error) {
          expect((error as ValidationError).statusCode).toBe(400);
        }
      });
    });

    // ------------------------------------------------------------------------
    describe("events", () => {
      const events = () => {
        const store = s().events;
        if (!store) throw new Error("this provider has no event log");
        return store;
      };
      const event = (type: string, data: Record<string, unknown> = {}, runId?: string) => ({ type, data, runId });

      it("is reported by capabilities and exposed", () => {
        expect(caps().events).toBe(true);
        expect(s().events).toBeDefined();
      });

      it("numbers a conversation's events 1, 2, 3 in the order they were appended, across calls", async () => {
        const conv = await newConversation();
        const first = await events().append(conv.id, [event("user.message", { content: "hi" }), event("session.status_running", { trigger: "message" })]);
        expect(first.map((e) => e.seq)).toEqual([1, 2]);
        expect(first[0]).toMatchObject({ conversationId: conv.id, type: "user.message", data: { content: "hi" } });
        expect(first[0]!.createdAt).toBeInstanceOf(Date);
        const second = await events().append(conv.id, [event("agent.message", { content: "yo" })]);
        expect(second.map((e) => e.seq)).toEqual([3]);

        const page = await events().list(conv.id);
        expect(page.events.map((e) => [e.seq, e.type])).toEqual([[1, "user.message"], [2, "session.status_running"], [3, "agent.message"]]);
        expect(page).toMatchObject({ hasMore: false, lastSeq: 3 });
      });

      it("keeps the sequences of different conversations apart", async () => {
        const [a, b] = [await newConversation(), await newConversation()];
        await events().append(a.id, [event("x"), event("x"), event("x")]);
        expect((await events().append(b.id, [event("x")]))[0]!.seq).toBe(1);
        expect((await events().list(a.id)).events).toHaveLength(3);
        expect((await events().list(b.id)).events).toHaveLength(1);
      });

      it("reads back what was written: data exactly as JSON, run id, and an empty data as {}", async () => {
        const conv = await newConversation();
        const [stored] = await events().append(conv.id, [event("agent.tool_use", awkwardJson(), "run_abc")]);
        const [bare] = await events().append(conv.id, [{ type: "session.work_done" }]);
        const read = (await events().list(conv.id)).events;
        expect(read[0]!.data).toEqual(jsonRoundTrip(awkwardJson()));
        expect(stored!.data).toEqual(jsonRoundTrip(awkwardJson()));
        expect(read[0]!.runId).toBe("run_abc");
        expect(read[1]!.runId).toBeUndefined();
        expect(read[1]!.data).toEqual({});
        expect(bare!.data).toEqual({});
        expect(read[0]!.createdAt).toEqual(stored!.createdAt);
      });

      it("lists after a cursor, by type, newest first, with hasMore / lastSeq as the paging cursor", async () => {
        const conv = await newConversation();
        await events().append(conv.id, Array.from({ length: 10 }, (_, i) => event(i % 2 ? "b" : "a", { i })));

        const first = await events().list(conv.id, { limit: 4 });
        expect(first.events.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
        expect(first).toMatchObject({ hasMore: true, lastSeq: 4 });
        const next = await events().list(conv.id, { after: first.lastSeq, limit: 4 });
        expect(next.events.map((e) => e.seq)).toEqual([5, 6, 7, 8]);
        const last = await events().list(conv.id, { after: next.lastSeq, limit: 4 });
        expect(last.events.map((e) => e.seq)).toEqual([9, 10]);
        expect(last).toMatchObject({ hasMore: false, lastSeq: 10 });

        // an empty page keeps the cursor
        expect(await events().list(conv.id, { after: 10 })).toMatchObject({ events: [], hasMore: false, lastSeq: 10 });
        expect(await events().list(conv.id, { after: 99 })).toMatchObject({ events: [], lastSeq: 99 });

        expect((await events().list(conv.id, { types: ["b"] })).events.map((e) => e.seq)).toEqual([2, 4, 6, 8, 10]);
        expect((await events().list(conv.id, { types: ["a", "b"], after: 8 })).events.map((e) => e.seq)).toEqual([9, 10]);
        expect((await events().list(conv.id, { order: "desc", limit: 3 })).events.map((e) => e.seq)).toEqual([10, 9, 8]);
        expect((await events().list(conv.id, { order: "desc", before: 4, limit: 10 })).events.map((e) => e.seq)).toEqual([3, 2, 1]);
        expect((await events().list(conv.id, { types: ["a"], order: "desc", limit: 1 })).events.map((e) => e.seq)).toEqual([9]);
      });

      it("clamps the page size", async () => {
        const conv = await newConversation();
        await events().append(conv.id, Array.from({ length: 5 }, () => event("x")));
        expect((await events().list(conv.id, { limit: 0 })).events).toHaveLength(5);
        expect((await events().list(conv.id, { limit: -3 })).events).toHaveLength(5);
        expect((await events().list(conv.id, { limit: 2 })).events).toHaveLength(2);
        expect((await events().list(conv.id, { limit: 5_000_000 })).events).toHaveLength(5);
      });

      it("lists nothing for a conversation without events, and refuses to append to one that does not exist", async () => {
        const conv = await newConversation();
        expect(await events().list(conv.id)).toMatchObject({ events: [], hasMore: false, lastSeq: 0 });
        expect(await events().list("conv_never-existed")).toMatchObject({ events: [] });
        await expect(events().append("conv_never-existed", [event("x")])).rejects.toBeInstanceOf(NotFoundError);
        expect(await events().append(conv.id, [])).toEqual([]);
        await expect(events().append(conv.id, [{ type: "" }])).rejects.toBeInstanceOf(ValidationError);
        await expect(events().append(conv.id, [{ type: "t".repeat(65) }])).rejects.toBeInstanceOf(ValidationError);
        await expect(events().append(conv.id, [{ type: "x", runId: "r".repeat(65) }])).rejects.toBeInstanceOf(ValidationError);
        // a refused batch stores nothing
        await expect(events().append(conv.id, [event("ok"), { type: "" }])).rejects.toBeInstanceOf(ValidationError);
        expect((await events().list(conv.id)).events).toHaveLength(0);
      });

      it("hands out unique, gap-free sequence numbers to appenders running at the same time", async () => {
        const conv = await newConversation();
        const results = await Promise.all(
          Array.from({ length: 24 }, (_, i) => events().append(conv.id, i % 3 === 0 ? [event("x", { i }), event("y", { i })] : [event("x", { i })]))
        );
        const all = (await events().list(conv.id, { limit: 1000 })).events;
        const expected = results.reduce((n, r) => n + r.length, 0);
        expect(all).toHaveLength(expected);
        expect(all.map((e) => e.seq)).toEqual(Array.from({ length: expected }, (_, i) => i + 1));
        // one append's events are consecutive
        for (const result of results) {
          for (let i = 1; i < result.length; i++) expect(result[i]!.seq).toBe(result[i - 1]!.seq + 1);
        }
      });

      it("summarises the last sequence number and the stop reason of the last finished turn", async () => {
        const [a, b, none] = [await newConversation(), await newConversation(), await newConversation()];
        await events().append(a.id, [event("user.message"), event("session.status_running"), event("session.status_idle", { stop_reason: "end_turn" })]);
        await events().append(b.id, [event("session.status_running"), event("session.status_idle", { stop_reason: "requires_action" }), event("action.resolved"), event("session.status_running")]);

        const summary = await events().summary!([a.id, b.id, none.id, "conv_never-existed"]);
        expect(summary[a.id]).toEqual({ lastSeq: 3, stopReason: "end_turn" });
        // a new turn clears the reason of the previous one
        expect(summary[b.id]).toEqual({ lastSeq: 4 });
        expect(summary[none.id]).toBeUndefined();
        expect(summary["conv_never-existed"]).toBeUndefined();

        await events().append(b.id, [event("session.status_idle", { stop_reason: "cancelled" })]);
        expect((await events().summary!([b.id]))[b.id]).toEqual({ lastSeq: 5, stopReason: "cancelled" });
        expect(await events().summary!([])).toEqual({});
      });

      it("goes with its conversation", async () => {
        const conv = await newConversation();
        await events().append(conv.id, [event("x"), event("session.status_idle", { stop_reason: "end_turn" })]);
        await s().deleteConversation(conv.id);
        expect((await events().list(conv.id)).events).toEqual([]);
        expect((await events().summary!([conv.id]))[conv.id]).toBeUndefined();
        await expect(events().append(conv.id, [event("x")])).rejects.toBeInstanceOf(NotFoundError);
      });

      it("survives a restart and keeps counting", async () => {
        const conv = await newConversation();
        await events().append(conv.id, [event("x", { n: 1 }), event("session.status_idle", { stop_reason: "end_turn" })]);
        const reopened = await handle.reopen();
        expect((await reopened.events!.list(conv.id)).events.map((e) => e.seq)).toEqual([1, 2]);
        expect((await reopened.events!.append(conv.id, [event("x", { n: 3 })]))[0]!.seq).toBe(3);
        expect((await reopened.events!.summary!([conv.id]))[conv.id]).toEqual({ lastSeq: 3, stopReason: "end_turn" });
      });

      it("prunes old events, keeps the newer ones, and keeps counting from where it was", async () => {
        const conv = await newConversation();
        await withFrozenDate(T0, async (clock) => {
          await events().append(conv.id, [event("old"), event("old")]);
          clock.set(T0 + 10_000);
          await events().append(conv.id, [event("new")]);
        });
        expect(await events().prune!(new Date(T0 + 5_000))).toBeGreaterThanOrEqual(2);
        expect((await events().list(conv.id)).events.map((e) => [e.seq, e.type])).toEqual([[3, "new"]]);
        expect((await events().append(conv.id, [event("after")]))[0]!.seq).toBe(4);
      });
    });

    // ------------------------------------------------------------------------
    describe("leases", () => {
      const lease = () => {
        const provider = s();
        if (!provider.acquireLease) throw new Error("this provider has no leases");
        return provider as Required<Pick<StorageProvider, "acquireLease" | "renewLease" | "releaseLease" | "getLeases" | "markLeaseCancel" | "listExpiredLeases">>;
      };
      const key = () => uniq("lease");

      it("is reported by capabilities", () => {
        expect(caps().leases).toBe(true);
      });

      it("is held by the first asker and refused to the second, who is told who holds it", async () => {
        const k = key();
        const first = await lease().acquireLease({ key: k, owner: "node-a", ttlMs: 60_000, data: { runId: "run_1", nested: { a: [1, 2] } } });
        expect(first).toMatchObject({ acquired: true, lease: { key: k, owner: "node-a", data: { runId: "run_1", nested: { a: [1, 2] } } } });
        expect((first as { takenOver?: unknown }).takenOver).toBeUndefined();
        expect((first as { lease: { expiresAt: Date } }).lease.expiresAt.getTime()).toBeGreaterThan(Date.now() + 30_000);

        const second = await lease().acquireLease({ key: k, owner: "node-b", ttlMs: 60_000 });
        expect(second).toMatchObject({ acquired: false, lease: { key: k, owner: "node-a", data: { runId: "run_1" } } });
        // the loser did not change anything
        expect((await lease().getLeases([k]))[0]).toMatchObject({ owner: "node-a", data: { runId: "run_1" } });
      });

      it("can be acquired again by its own owner (it renews and replaces the data)", async () => {
        const k = key();
        await lease().acquireLease({ key: k, owner: "node-a", ttlMs: 60_000, data: { v: 1 } });
        const again = await lease().acquireLease({ key: k, owner: "node-a", ttlMs: 60_000, data: { v: 2 } });
        expect(again).toMatchObject({ acquired: true, lease: { data: { v: 2 } } });
        expect((again as { takenOver?: unknown }).takenOver).toBeUndefined();
      });

      it("is taken over once it has expired, and the taker is handed the residue", async () => {
        const k = key();
        await withFrozenDate(T0, async (clock) => {
          await lease().acquireLease({ key: k, owner: "dead-node", ttlMs: 1_000, data: { runId: "run_dead" } });
          clock.set(T0 + 500);
          expect(await lease().acquireLease({ key: k, owner: "node-b", ttlMs: 1_000 })).toMatchObject({ acquired: false });
          clock.set(T0 + 1_500);
          const taken = await lease().acquireLease({ key: k, owner: "node-b", ttlMs: 1_000, data: { runId: "run_new" } });
          expect(taken).toMatchObject({
            acquired: true,
            lease: { owner: "node-b", data: { runId: "run_new" } },
            takenOver: { key: k, owner: "dead-node", data: { runId: "run_dead" } },
          });
          // the old holder cannot renew or release what is no longer its own
          expect(await lease().renewLease({ key: k, owner: "dead-node", ttlMs: 1_000 })).toBeNull();
          expect(await lease().releaseLease({ key: k, owner: "dead-node" })).toBe(false);
          expect((await lease().getLeases([k]))[0]).toMatchObject({ owner: "node-b" });
        });
      });

      it("is renewed only by its owner and only while it is alive", async () => {
        const k = key();
        await withFrozenDate(T0, async (clock) => {
          await lease().acquireLease({ key: k, owner: "node-a", ttlMs: 1_000 });
          expect(await lease().renewLease({ key: k, owner: "node-b", ttlMs: 5_000 })).toBeNull();
          clock.set(T0 + 800);
          const renewed = await lease().renewLease({ key: k, owner: "node-a", ttlMs: 1_000 });
          expect(renewed!.expiresAt.getTime()).toBe(T0 + 1_800);
          clock.set(T0 + 1_500); // past the first expiry, inside the renewed one
          expect(await lease().renewLease({ key: k, owner: "node-a", ttlMs: 1_000 })).not.toBeNull();
          clock.set(T0 + 10_000);
          expect(await lease().renewLease({ key: k, owner: "node-a", ttlMs: 1_000 })).toBeNull();
        });
        expect(await lease().renewLease({ key: key(), owner: "node-a", ttlMs: 1_000 })).toBeNull();
      });

      it("is released by its owner, not by anybody else", async () => {
        const k = key();
        await lease().acquireLease({ key: k, owner: "node-a", ttlMs: 60_000 });
        expect(await lease().releaseLease({ key: k, owner: "node-b" })).toBe(false);
        expect(await lease().getLeases([k])).toHaveLength(1);
        expect(await lease().releaseLease({ key: k, owner: "node-a" })).toBe(true);
        expect(await lease().getLeases([k])).toEqual([]);
        expect(await lease().releaseLease({ key: k, owner: "node-a" })).toBe(false);
        expect(await lease().acquireLease({ key: k, owner: "node-b", ttlMs: 60_000 })).toMatchObject({ acquired: true });
      });

      it("reports the live ones among the keys asked for, not the expired or unknown ones", async () => {
        const [live, dead, never] = [key(), key(), key()];
        await withFrozenDate(T0, async (clock) => {
          await lease().acquireLease({ key: live, owner: "a", ttlMs: 60_000 });
          await lease().acquireLease({ key: dead, owner: "a", ttlMs: 1_000 });
          clock.set(T0 + 5_000);
          const found = await lease().getLeases([live, dead, never, live]);
          expect(found.map((l) => l.key)).toEqual([live]);
        });
        expect(await lease().getLeases([])).toEqual([]);
      });

      it("carries a cancel request to the holder's next renewal", async () => {
        const k = key();
        await withFrozenDate(T0, async (clock) => {
          await lease().acquireLease({ key: k, owner: "node-a", ttlMs: 10_000 });
          expect((await lease().renewLease({ key: k, owner: "node-a", ttlMs: 10_000 }))!.cancelRequested).toBeFalsy();
          expect(await lease().markLeaseCancel(k)).toBe(true);
          expect((await lease().getLeases([k]))[0]!.cancelRequested).toBe(true);
          expect((await lease().renewLease({ key: k, owner: "node-a", ttlMs: 10_000 }))!.cancelRequested).toBe(true);
          expect(await lease().markLeaseCancel(key())).toBe(false);
          clock.set(T0 + 60_000);
          expect(await lease().markLeaseCancel(k)).toBe(false);
          // a new holder starts without the old request
          await lease().acquireLease({ key: k, owner: "node-b", ttlMs: 10_000 });
          expect((await lease().renewLease({ key: k, owner: "node-b", ttlMs: 10_000 }))!.cancelRequested).toBeFalsy();
        });
      });

      it("lists the expired ones, oldest first, by prefix, and leaves the live ones out", async () => {
        const prefix = uniq("sweep") + ":";
        await withFrozenDate(T0, async (clock) => {
          await lease().acquireLease({ key: `${prefix}b`, owner: "a", ttlMs: 2_000, data: { n: 2 } });
          await lease().acquireLease({ key: `${prefix}a`, owner: "a", ttlMs: 1_000, data: { n: 1 } });
          await lease().acquireLease({ key: `${prefix}live`, owner: "a", ttlMs: 600_000 });
          await lease().acquireLease({ key: uniq("other:x"), owner: "a", ttlMs: 1_000 });
          clock.set(T0 + 10_000);
          const expired = await lease().listExpiredLeases({ prefix });
          expect(expired.map((l) => l.key)).toEqual([`${prefix}a`, `${prefix}b`]);
          expect(expired[0]).toMatchObject({ owner: "a", data: { n: 1 } });
          expect(await lease().listExpiredLeases({ prefix, limit: 1 })).toHaveLength(1);
          expect(await lease().listExpiredLeases({ prefix: `${prefix}live` })).toEqual([]);
          // a prefix is a prefix, not a pattern
          expect(await lease().listExpiredLeases({ prefix: "%" })).toEqual([]);
          expect(await lease().listExpiredLeases({ prefix: ".*" })).toEqual([]);
        });
      });

      it("goes to exactly one of several askers that ask at the same time", async () => {
        const k = key();
        const results = await Promise.all(
          Array.from({ length: 12 }, (_, i) => lease().acquireLease({ key: k, owner: `node-${i}`, ttlMs: 60_000 }))
        );
        expect(results.filter((r) => r.acquired)).toHaveLength(1);
        const winner = results.find((r) => r.acquired)!.lease.owner;
        for (const r of results.filter((r) => !r.acquired)) expect(r.lease.owner).toBe(winner);
      });

      it("keeps a lease across a restart", async () => {
        const k = key();
        await lease().acquireLease({ key: k, owner: "node-a", ttlMs: 60_000, data: { runId: "run_x" } });
        const reopened = await handle.reopen();
        expect((await reopened.getLeases!([k]))[0]).toMatchObject({ owner: "node-a", data: { runId: "run_x" } });
      });

      it("refuses a malformed key, owner or lifetime", async () => {
        await expect(lease().acquireLease({ key: "", owner: "a", ttlMs: 1000 })).rejects.toBeInstanceOf(ValidationError);
        await expect(lease().acquireLease({ key: "k".repeat(129), owner: "a", ttlMs: 1000 })).rejects.toBeInstanceOf(ValidationError);
        await expect(lease().acquireLease({ key: key(), owner: "", ttlMs: 1000 })).rejects.toBeInstanceOf(ValidationError);
        await expect(lease().acquireLease({ key: key(), owner: "a", ttlMs: 0 })).rejects.toBeInstanceOf(ValidationError);
        await expect(lease().acquireLease({ key: key(), owner: "a", ttlMs: Number.NaN })).rejects.toBeInstanceOf(ValidationError);
      });
    });

    // ------------------------------------------------------------------------
    describe("compare-and-set updates", () => {
      const cas = (id: string, version: number, params: Parameters<StorageProvider["updateConversation"]>[1]) =>
        s().updateConversationIf!(id, version, params);

      it("counts updates in the conversation's version, and a message is not one", async () => {
        const created = await newConversation();
        expect(created.version).toBe(0);
        const one = await s().updateConversation(created.id, { title: "one" });
        expect(one.version).toBe(1);
        // a message touches updatedAt but is not a change to the conversation record
        await s().createMessage({ conversationId: created.id, role: "user", content: "hi" });
        expect((await s().getConversation(created.id))!.version).toBe(1);
        const two = await s().updateConversation(created.id, { state: { a: 1 } });
        expect(two.version).toBe(2);
        expect((await s().getConversation(created.id))!.version).toBe(2);
        expect((await s().getConversations({ agentId: created.agentId })).data[0]!.version).toBe(2);
      });

      it("updates when the version matches and says so with the new record", async () => {
        const created = await newConversation({ title: "t", state: { n: 0 } });
        const updated = await cas(created.id, 0, { state: { n: 1 }, title: "u" });
        expect(updated).toMatchObject({ id: created.id, title: "u", state: { n: 1 }, version: 1 });
        expect(await s().getConversation(created.id)).toEqual(updated);
        // each field is optional, like a plain update
        const again = await cas(created.id, 1, { metadata: { m: 1 } });
        expect(again).toMatchObject({ title: "u", state: { n: 1 }, metadata: { m: 1 }, version: 2 });
      });

      it("changes nothing and answers null when somebody else updated first", async () => {
        const created = await newConversation({ state: { n: 0 } });
        await s().updateConversation(created.id, { state: { n: 1 } });
        expect(await cas(created.id, 0, { state: { n: 99 }, title: "lost" })).toBeNull();
        const now = (await s().getConversation(created.id))!;
        expect(now).toMatchObject({ state: { n: 1 }, version: 1 });
        expect(now.title).toBeUndefined();
        // a version from the future does not match either
        expect(await cas(created.id, 5, { title: "future" })).toBeNull();
      });

      it("an unknown conversation is a 404, a bad version a 400, a state too large a 413", async () => {
        await expect(cas("conv_nope", 0, { title: "x" })).rejects.toBeInstanceOf(NotFoundError);
        const created = await newConversation();
        await expect(cas(created.id, -1, { title: "x" })).rejects.toBeInstanceOf(ValidationError);
        await expect(cas(created.id, 1.5, { title: "x" })).rejects.toBeInstanceOf(ValidationError);
        const tooBig = { blob: "x".repeat(Math.min(caps().maxStateBytes + 1024, 40 * MiB)) };
        if (Buffer.byteLength(JSON.stringify(tooBig)) > caps().maxStateBytes) {
          await expect(cas(created.id, 0, { state: tooBig })).rejects.toMatchObject({ statusCode: 413 });
          expect((await s().getConversation(created.id))!.version).toBe(0);
        }
      });

      it("of 20 writers that read the same version exactly one wins", async () => {
        const created = await newConversation({ state: { n: 0 } });
        const results = await Promise.all(
          Array.from({ length: 20 }, (_, i) => cas(created.id, 0, { state: { winner: i }, title: `w${i}` }))
        );
        const winners = results.filter((r) => r !== null);
        expect(winners).toHaveLength(1);
        const stored = (await s().getConversation(created.id))!;
        expect(stored.version).toBe(1);
        expect(stored.state).toEqual(winners[0]!.state);
        expect(stored.title).toBe(winners[0]!.title);
      });

      it("read-modify-write with a retry loses no update", async () => {
        const created = await newConversation({ state: { count: 0 } });
        const bump = async () => {
          for (;;) {
            const fresh = (await s().getConversation(created.id))!;
            const done = await s().updateConversationIf!(created.id, fresh.version!, {
              state: { count: (fresh.state as { count: number }).count + 1 },
            });
            if (done) return;
          }
        };
        await Promise.all(Array.from({ length: 15 }, bump));
        const stored = (await s().getConversation(created.id))!;
        expect((stored.state as { count: number }).count).toBe(15);
        expect(stored.version).toBe(15);
      });

      it("a plain update and a conditional one are ordered by the version too", async () => {
        const created = await newConversation();
        const read = (await s().getConversation(created.id))!;
        await s().updateConversation(created.id, { title: "plain" });
        expect(await cas(created.id, read.version!, { title: "stale" })).toBeNull();
        expect((await s().getConversation(created.id))!.title).toBe("plain");
      });
    });

    // ------------------------------------------------------------------------
    describe("action deadlines", () => {
      const minute = 60_000;

      it("stores the moment the earliest action lapses, and clears it", async () => {
        const created = await newConversation();
        expect(created.actionDueAt).toBeUndefined();
        const due = new Date(Date.now() + 5 * minute);
        const set = await s().updateConversation(created.id, { actionDueAt: due, state: { x: 1 } });
        expect(set.actionDueAt!.getTime()).toBe(due.getTime());
        expect((await s().getConversation(created.id))!.actionDueAt!.getTime()).toBe(due.getTime());
        // another update leaves it alone
        expect((await s().updateConversation(created.id, { title: "t" })).actionDueAt!.getTime()).toBe(due.getTime());
        // a conditional update sets and clears it too
        const read = (await s().getConversation(created.id))!;
        const moved = await s().updateConversationIf!(created.id, read.version!, { actionDueAt: new Date(due.getTime() + minute) });
        expect(moved!.actionDueAt!.getTime()).toBe(due.getTime() + minute);
        const cleared = await s().updateConversation(created.id, { actionDueAt: null });
        expect(cleared.actionDueAt).toBeUndefined();
        expect((await s().getConversation(created.id))!.actionDueAt).toBeUndefined();
      });

      it("lists the conversations that are due, earliest first, and not the rest", async () => {
        const agentId = uniq("agent");
        const base = Date.now();
        const a = await s().createConversation({ agentId });
        const b = await s().createConversation({ agentId });
        const c = await s().createConversation({ agentId });
        const none = await s().createConversation({ agentId });
        await s().updateConversation(a.id, { actionDueAt: new Date(base - 1 * minute) });
        await s().updateConversation(b.id, { actionDueAt: new Date(base - 3 * minute) });
        await s().updateConversation(c.id, { actionDueAt: new Date(base + 10 * minute) });

        const due = await s().getConversations({ actionDueBefore: new Date(base), limit: 500 });
        const ours = due.data.filter((conv) => conv.agentId === agentId).map((conv) => conv.id);
        expect(ours).toEqual([b.id, a.id]);
        expect(due.total).toBeGreaterThanOrEqual(2);

        // the boundary is inclusive
        const exact = await s().getConversations({ actionDueBefore: new Date(base - 1 * minute), limit: 500 });
        expect(exact.data.filter((conv) => conv.agentId === agentId).map((conv) => conv.id)).toEqual([b.id, a.id]);
        const later = await s().getConversations({ actionDueBefore: new Date(base + 11 * minute), limit: 500 });
        expect(later.data.filter((conv) => conv.agentId === agentId).map((conv) => conv.id)).toEqual([b.id, a.id, c.id]);
        expect(later.data.some((conv) => conv.id === none.id)).toBe(false);

        // answering clears the deadline and the conversation drops out
        await s().updateConversation(b.id, { actionDueAt: null });
        const after = await s().getConversations({ actionDueBefore: new Date(base), limit: 500 });
        expect(after.data.filter((conv) => conv.agentId === agentId).map((conv) => conv.id)).toEqual([a.id]);
      });

      it("pages through the due conversations without a gap or a repeat", async () => {
        const agentId = uniq("agent");
        const base = Date.now() - 10 * minute;
        const ids: string[] = [];
        for (let i = 0; i < 5; i++) {
          const conv = await s().createConversation({ agentId });
          ids.push(conv.id);
          // the same instant for three of them: the order inside a tie must still be stable
          await s().updateConversation(conv.id, { actionDueAt: new Date(base + (i < 3 ? 0 : i) * 1000) });
        }
        const seen: string[] = [];
        for (let offset = 0; offset < 5; offset += 2) {
          const page = await s().getConversations({ actionDueBefore: new Date(), agentId, limit: 2, offset });
          seen.push(...page.data.map((conv) => conv.id));
          expect(page.total).toBe(5);
        }
        expect(seen).toEqual(ids);
      });

      it("rejects a deadline that is not a date", async () => {
        const created = await newConversation();
        await expect(s().updateConversation(created.id, { actionDueAt: "tomorrow" as unknown as Date })).rejects.toBeInstanceOf(ValidationError);
        await expect(s().getConversations({ actionDueBefore: "now" as unknown as Date })).rejects.toBeInstanceOf(ValidationError);
      });
    });

    // ------------------------------------------------------------------------
    describe("updating a message", () => {
      it("replaces the metadata and leaves everything else as it was", async () => {
        await withFrozenDate(T0, async (clock) => {
          const conv = await newConversation();
          const first = await s().createMessage({ conversationId: conv.id, role: "assistant", content: "paused", metadata: { requiresAction: true, pendingActions: [{ id: "a1", status: "pending" }] } });
          const second = await s().createMessage({ conversationId: conv.id, role: "user", content: "next" });
          clock.set(T0 + 5000);
          const updated = await s().updateMessage!(first.id, {
            metadata: { requiresAction: true, pendingActions: [{ id: "a1", status: "resolved", resolvedBy: "u1" }] },
          });
          expect(updated).toMatchObject({
            id: first.id,
            conversationId: conv.id,
            role: "assistant",
            content: "paused",
            metadata: { requiresAction: true, pendingActions: [{ id: "a1", status: "resolved", resolvedBy: "u1" }] },
          });
          expect(updated.createdAt.getTime()).toBe(T0);
          expect(updated.updatedAt.getTime()).toBe(T0 + 5000);
          expect(await s().getMessage(first.id)).toEqual(updated);
          // the history keeps its order, and the other message is untouched
          expect((await s().getMessages(conv.id)).data.map((m) => m.id)).toEqual([first.id, second.id]);
          expect(await s().getMessage(second.id)).toEqual(second);
        });
      });

      it("replaces the content when asked, text or parts", async () => {
        const conv = await newConversation();
        const message = await s().createMessage({ conversationId: conv.id, role: "assistant", content: "old", metadata: { keep: 1 } });
        const text = await s().updateMessage!(message.id, { content: "new" });
        expect(text).toMatchObject({ content: "new", metadata: { keep: 1 } });
        const parts = [{ type: "text", text: "p" }];
        expect((await s().updateMessage!(message.id, { content: parts })).content).toEqual(parts);
        // an empty update still moves updatedAt and changes nothing else
        expect(await s().updateMessage!(message.id, {})).toMatchObject({ content: parts, metadata: { keep: 1 } });
      });

      it("round-trips awkward metadata as JSON", async () => {
        const conv = await newConversation();
        const message = await s().createMessage({ conversationId: conv.id, role: "assistant", content: "x" });
        const input = awkwardJson();
        const updated = await s().updateMessage!(message.id, { metadata: input });
        expect(updated.metadata).toEqual(jsonRoundTrip(input));
        expect((await s().getMessage(message.id))!.metadata).toEqual(jsonRoundTrip(input));
      });

      it("an unknown message is a 404, and it is not a way to touch the conversation", async () => {
        await expect(s().updateMessage!("msg_nope", { metadata: {} })).rejects.toBeInstanceOf(NotFoundError);
        const conv = await newConversation();
        const message = await s().createMessage({ conversationId: conv.id, role: "assistant", content: "x" });
        const before = (await s().getConversation(conv.id))!;
        await s().updateMessage!(message.id, { metadata: { a: 1 } });
        expect((await s().getConversation(conv.id))!.version).toBe(before.version);
      });
    });

    // ------------------------------------------------------------------------
    describe("tasks that run in a conversation", () => {
      it("links a task to a conversation, filters by it, and updates the link", async () => {
        const conv = await newConversation();
        const agentId = uniq("agent");
        const linked = await s().createTask({ agentId, input: "linked", conversationId: conv.id });
        const plain = await s().createTask({ agentId, input: "plain" });
        expect(linked.conversationId).toBe(conv.id);
        expect(plain.conversationId).toBeUndefined();
        expect((await s().getTask(linked.id))!.conversationId).toBe(conv.id);

        const later = await s().updateTask(plain.id, { conversationId: conv.id });
        expect(later.conversationId).toBe(conv.id);
        const found = await s().getTasks({ conversationId: conv.id, limit: 100 });
        expect(found.data.map((t) => t.id).sort()).toEqual([linked.id, plain.id].sort());
        expect((await s().getTasks({ conversationId: uniq("conv") })).data).toEqual([]);

        // it also takes the new "cancelled" status
        expect((await s().updateTask(plain.id, { status: "cancelled" })).status).toBe("cancelled");
        expect((await s().getTasks({ conversationId: conv.id, status: "cancelled" })).data.map((t) => t.id)).toEqual([plain.id]);
      });
    });

    // ------------------------------------------------------------------------
    describe("persistence", () => {
      it("everything written is still there after a restart", async () => {
        const conv = await newConversation({ userId: "u-restart", title: "kept", state: { a: awkwardJson() } });
        const message = await s().createMessage({ conversationId: conv.id, role: "user", content: AWKWARD_TEXTS.nul });
        const content = randomBytes(300_000);
        const expiresAt = new Date(Date.now() + 7 * 86_400_000);
        const file = await s().saveFile({
          name: "r.bin",
          mimeType: "application/octet-stream",
          content,
          conversationId: conv.id,
          userId: "u-restart",
          agentId: conv.agentId,
          expiresAt,
        });
        const due = new Date(Date.now() + 3_600_000);
        await s().updateConversation(conv.id, { actionDueAt: due });
        const edited = await s().updateMessage!(message.id, { metadata: { settled: { id: "a1", status: "resolved" } } });
        const task = await s().createTask({ agentId: conv.agentId, input: "again" });
        const comment = { id: "c1", taskId: task.id, role: "user" as const, content: "hi", createdAt: new Date(T0) };
        await s().updateTask(task.id, { comments: [comment] });
        await s().createTaskResult({ taskId: task.id, content: "result" });

        const reopened = await handle.reopen();
        expect(reopened.isConnected()).toBe(true);
        const read = await reopened.getConversation(conv.id);
        expect(read).toMatchObject({ title: "kept", userId: "u-restart" });
        expect(read!.state).toEqual(jsonRoundTrip({ a: awkwardJson() }));
        // the version counts on after a restart, and so does the deadline the expiry sweep looks for
        expect(read!.version).toBe(1);
        expect(read!.actionDueAt!.getTime()).toBe(due.getTime());
        expect((await reopened.getConversations({ actionDueBefore: new Date(due.getTime() + 1000), agentId: conv.agentId })).data.map((c) => c.id)).toEqual([conv.id]);
        expect(await reopened.updateConversationIf!(conv.id, 0, { title: "stale" })).toBeNull();
        expect((await reopened.updateConversationIf!(conv.id, 1, { title: "fresh" }))!.version).toBe(2);
        expect((await reopened.getMessage(message.id))!.metadata).toEqual(edited.metadata);
        expect((await reopened.getMessage(message.id))!.content).toBe(AWKWARD_TEXTS.nul);
        expect((await reopened.getFileContent(file.id))!.equals(content)).toBe(true);
        const reread = await reopened.getFile(file.id);
        expect(reread).toMatchObject({ userId: "u-restart", agentId: conv.agentId });
        expect(reread!.expiresAt!.getTime()).toBe(expiresAt.getTime());
        expect((await reopened.listFiles!({ conversationId: conv.id })).data.map((f) => f.id)).toEqual([file.id]);
        expect((await reopened.getTask(task.id))!.comments).toEqual([comment]);
        expect((await reopened.getTaskResult(task.id))!.content).toBe("result");
      });
    });
  });
}
