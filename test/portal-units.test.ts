/**
 * The pure parts of the portal release: title cleaning, starters, export rendering, client tool deadlines and records.
 */

import { describe, expect, it } from "vitest";
import { readActions } from "../src/host.js";
import { CLIENT_TOOL_GRACE_SECONDS, recordableResolution, stampDeadlines } from "../src/hitl.js";
import { closedExperience, effectiveExperience, experienceFromMetadata, mergeExperience, normalizeReasons, normalizeStarters, normalizeWelcome, resolveExperience } from "../src/experience.js";
import { exportFileName, htmlContentSecurityPolicy, messageText, renderHtml, renderJson, renderMarkdown, resolveLabels, toolCallsByAnswer } from "../src/export.js";
import type { ToolLogEvent } from "../src/export.js";
import type { Transcript } from "../src/export.js";
import { assertTitleGeneration, cleanTitle, titlePrompt } from "../src/titles.js";
import type { Message, PendingAction } from "../src/index.js";

describe("cleanTitle", () => {
  it("removes what a model wraps around a title", () => {
    expect(cleanTitle('"Trip to Lisbon"')).toBe("Trip to Lisbon");
    expect(cleanTitle("“Lizbon gezisi”")).toBe("Lizbon gezisi");
    expect(cleanTitle("Title: Quarterly plan.")).toBe("Quarterly plan");
    expect(cleanTitle("Başlık: Yıllık izin")).toBe("Yıllık izin");
    expect(cleanTitle("**Weekly report**")).toBe("Weekly report");
    expect(cleanTitle("# A heading\nand some more text")).toBe("A heading and some more text");
    expect(cleanTitle("  spaced   out   words  ")).toBe("spaced out words");
  });

  it("cuts to the word limit and the length limit", () => {
    expect(cleanTitle("one two three four five six seven eight")).toBe("one two three four five six");
    expect(cleanTitle("one two three four", 2)).toBe("one two");
    expect(cleanTitle("x".repeat(500), 6)!.length).toBe(120);
  });

  it("says nothing for what is not a title", () => {
    for (const value of ["", "   ", '""', "***", undefined, null, 5, {}]) expect(cleanTitle(value as unknown)).toBeUndefined();
  });
});

describe("title configuration", () => {
  it("needs a generator or an endpoint", () => {
    expect(() => assertTitleGeneration({}, "t")).toThrow(/baseUrl and model/);
    expect(() => assertTitleGeneration({ baseUrl: "http://x" }, "t")).toThrow(/baseUrl and model/);
    expect(() => assertTitleGeneration({ generate: () => "x" }, "t")).not.toThrow();
    expect(() => assertTitleGeneration({ baseUrl: "http://x", model: "m", maxWords: 0 }, "t")).toThrow(/maxWords/);
    expect(() => assertTitleGeneration(false, "t")).not.toThrow();
    expect(() => assertTitleGeneration(undefined, "t")).not.toThrow();
    expect(() => assertTitleGeneration({ generate: 5 as unknown as () => string }, "t")).toThrow(/function/);
  });

  it("asks for the language of the message and the word limit, and clips what it sends", () => {
    const prompt = titlePrompt({ baseUrl: "x", model: "m", maxWords: 4, instructions: "No emoji." }, "u".repeat(5000), "answer");
    expect(prompt).toContain("at most 4 words");
    expect(prompt).toContain("same language");
    expect(prompt).toContain("No emoji.");
    expect(prompt).toContain("Assistant answer:\nanswer");
    expect(prompt.length).toBeLessThan(2600);
  });
});

describe("experience", () => {
  it("cleans starters: trims, cuts, drops empties, keeps six", () => {
    const starters = normalizeStarters([
      "  plain string  ",
      { text: "x".repeat(600), label: "y".repeat(100), autoSend: true },
      { text: "   " },
      { label: "no text" },
      42,
      ...Array.from({ length: 10 }, (_, i) => ({ text: `s${i}` })),
    ]);
    expect(starters).toHaveLength(6);
    expect(starters[0]).toEqual({ text: "plain string" });
    expect(starters[1]!.text).toHaveLength(500);
    expect(starters[1]!.label).toHaveLength(80);
    expect(starters[1]!.autoSend).toBe(true);
    expect(normalizeStarters("nope")).toEqual([]);
  });

  it("cleans the welcome text and the reason codes", () => {
    expect(normalizeWelcome("  hi  ")).toBe("hi");
    expect(normalizeWelcome("")).toBeUndefined();
    expect(normalizeWelcome(5)).toBeUndefined();
    expect(normalizeWelcome("x".repeat(5000))).toHaveLength(4000);
    expect(normalizeReasons([" Wrong ", "wrong", "has space", "ok_1", 7, "x".repeat(65)])).toEqual(["wrong", "ok_1"]);
    expect(normalizeReasons("nope")).toBeUndefined();
  });

  it("reads what a host wrote in metadata, leniently", () => {
    expect(experienceFromMetadata(undefined)).toBeUndefined();
    expect(experienceFromMetadata({ experience: "no" })).toBeUndefined();
    expect(
      experienceFromMetadata({
        experience: { messageActions: { edit: false, copy: "yes" }, feedback: { reasons: ["A", "b"], enabled: 1 }, history: 3, export: { includeTools: true } },
      })
    ).toEqual({ messageActions: { edit: false }, feedback: { reasons: ["a", "b"] }, export: { includeTools: true } });
  });

  it("lays settings over each other group by group", () => {
    const merged = mergeExperience({ messageActions: { copy: false, edit: false }, welcome: "a" }, { messageActions: { edit: true }, starters: [{ text: "x" }] });
    expect(merged).toEqual({ messageActions: { copy: false, edit: true }, welcome: "a", starters: [{ text: "x" }] });
    expect(effectiveExperience({ config: { experience: { history: { pin: false } } }, agentExperience: { history: { rename: false } }, metadata: { experience: { history: { pin: true } } } }).history).toEqual({
      pin: true,
      rename: false,
    });
  });

  it("resolves every switch, with the comment box following the comment limit", () => {
    const resolved = resolveExperience({ config: { feedback: { maxCommentLength: 0 } }, titles: true, pdf: true });
    expect(resolved.feedback).toMatchObject({ enabled: true, comments: false, maxCommentLength: 0 });
    expect(resolved.export.formats).toEqual(["md", "json", "html", "pdf"]);
    expect(resolved.titles).toBe(true);
    const off = resolveExperience({ config: { export: { enabled: false, includeTools: true } }, titles: false, pdf: true });
    expect(off.export).toEqual({ enabled: false, includeTools: false, formats: [] });
  });

  it("closes every switch for an agent that cannot be resolved, whatever the server's defaults are", () => {
    const closed = closedExperience();
    expect(closed).toEqual({
      messageActions: { copy: false, regenerate: false, edit: false },
      history: { rename: false, pin: false, bulkDelete: false },
      feedback: { enabled: false, comments: false, reasons: [], maxCommentLength: 0 },
      export: { enabled: false, includeTools: false, formats: [] },
      titles: false,
    });
    // the defaults it stands in for are all on
    const defaults = resolveExperience({ config: {}, titles: false, pdf: false });
    expect(defaults.export.enabled && defaults.feedback.enabled && defaults.history.pin).toBe(true);
    // and every call gives a fresh object, so a caller cannot change what the next one sees
    closed.export.enabled = true;
    expect(closedExperience().export.enabled).toBe(false);
  });
});

describe("client tool deadlines and records", () => {
  const tool = (extra: Partial<Extract<PendingAction, { type: "client_tool" }>> = {}): PendingAction => ({ id: "c", type: "client_tool", toolName: "t", ...extra });
  const now = new Date("2026-10-11T10:00:00.000Z");

  it("stamps when it was asked and gives up on the page a grace period after its own timeout", () => {
    const [stamped] = stampDeadlines([tool({ timeoutSeconds: 30 })], 1440, now) as Array<Extract<PendingAction, { type: "client_tool" }>>;
    expect(stamped!.requestedAt).toBe("2026-10-11T10:00:00.000Z");
    expect(stamped!.expiresAt).toBe(new Date(now.getTime() + (30 + CLIENT_TOOL_GRACE_SECONDS) * 1000).toISOString());
  });

  it("keeps a deadline or request time the agent set, and falls back to the server's timeout", () => {
    const own = tool({ timeoutSeconds: 30, expiresAt: "2026-10-11T10:05:00.000Z", requestedAt: "2026-10-11T09:59:00.000Z" });
    expect(stampDeadlines([own], 1440, now)).toEqual([own]);
    const [plain] = stampDeadlines([tool()], 10, now) as Array<Extract<PendingAction, { type: "client_tool" }>>;
    expect(plain!.expiresAt).toBe("2026-10-11T10:10:00.000Z");
    const [never] = stampDeadlines([tool()], 0, now) as Array<Extract<PendingAction, { type: "client_tool" }>>;
    expect(never!.expiresAt).toBeUndefined();
  });

  it("does not touch the other kinds of action", () => {
    const approval: PendingAction = { id: "a", type: "tool_approval", toolName: "x" };
    expect(stampDeadlines([approval], 0, now)).toEqual([approval]);
  });

  it("records the size of a result, never the result", () => {
    expect(recordableResolution({ type: "client_tool", output: { secret: "value" } })).toEqual({ type: "client_tool", outputBytes: 18 });
    expect(recordableResolution({ type: "client_tool", error: "boom" })).toEqual({ type: "client_tool", error: "boom" });
    expect(recordableResolution({ type: "client_tool", output: null })).toEqual({ type: "client_tool", outputBytes: 4 });
    const approval = { type: "tool_approval", decision: "allow" } as const;
    expect(recordableResolution(approval)).toBe(approval);
  });

  it("is checked when a host reports it", () => {
    const ok = readActions([{ id: "c1", type: "client_tool", toolName: "read", args: { a: 1 }, timeoutSeconds: 5, junk: true }], "x");
    expect(ok).toEqual({ ok: true, value: [{ id: "c1", type: "client_tool", toolName: "read", args: { a: 1 }, timeoutSeconds: 5 }] });
    for (const bad of [{ id: "c1", type: "client_tool" }, { id: "c1", type: "client_tool", toolName: "t", args: [] }, { id: "c1", type: "client_tool", toolName: "t", timeoutSeconds: 0 }]) {
      expect(readActions([bad], "x").ok).toBe(false);
    }
  });
});

describe("export", () => {
  const message = (role: Message["role"], content: Message["content"], extra: Partial<Message> = {}): Message => ({
    id: `msg_${Math.random().toString(36).slice(2)}`,
    conversationId: "conv_1",
    role,
    content,
    createdAt: new Date("2026-10-11T10:00:00.000Z"),
    updatedAt: new Date("2026-10-11T10:00:00.000Z"),
    ...extra,
  });
  const transcript = (messages: Message[], extra: Partial<Transcript> = {}): Transcript => ({
    conversation: { id: "conv_1", agentId: "a", title: "Plan", createdAt: new Date("2026-10-11T09:00:00.000Z"), updatedAt: new Date("2026-10-11T10:00:00.000Z") },
    agentName: "Helper",
    messages,
    truncated: false,
    labels: resolveLabels("en", undefined),
    exportedAt: new Date("2026-10-11T11:00:00.000Z"),
    ...extra,
  });

  it("reads the text of every shape of content", () => {
    expect(messageText({ content: "plain" })).toBe("plain");
    expect(messageText({ content: [{ type: "text", text: "a" }, { type: "image_url", image_url: { url: "x" } }, { type: "file", file: { id: "f", name: "n.pdf", mimeType: "x" } }, { type: "weird" }] })).toBe(
      "a\n[image]\n[file: n.pdf]"
    );
  });

  it("names a file after the title, safely", () => {
    expect(exportFileName({ id: "conv_1", title: 'a/b\\c:d*e?"f<g>h|i' }, "md")).toBe("a b c d e f g h i.md");
    expect(exportFileName({ id: "conv_1" }, "json")).toBe("conv_1.json");
    expect(exportFileName({ id: "conv_1", title: "\u0000\u0001" }, "html")).toBe("conv_1.html");
    expect(exportFileName({ id: "c", title: "x".repeat(300) }, "md").length).toBeLessThanOrEqual(83);
  });

  it("picks the words of a locale, with the host's laid over", () => {
    expect(resolveLabels("tr", undefined).user).toBe("Siz");
    expect(resolveLabels("TR-tr", undefined).user).toBe("Siz");
    expect(resolveLabels("fr", undefined).user).toBe("You");
    expect(resolveLabels("fr", { fr: { user: "Vous" } }).user).toBe("Vous");
    expect(resolveLabels("tr", { tr: { assistant: "Yardımcı" } })).toMatchObject({ user: "Siz", assistant: "Yardımcı" });
    expect(resolveLabels(undefined, undefined).user).toBe("You");
  });

  it("renders Markdown with files, tool calls and the note about a cut conversation", () => {
    const answer = message("assistant", "found it");
    const md = renderMarkdown(
      transcript([message("user", "find", { files: [{ id: "f", name: "a.txt", mimeType: "text/plain", size: 1 }] }), answer], {
        tools: new Map([[answer.id, [{ name: "search", args: { q: "x" }, ok: false, error: "timeout", durationMs: 12 }]]]),
        truncated: true,
      })
    );
    expect(md).toContain("# Plan");
    expect(md).toContain("> Only the newest messages are included.");
    expect(md).toContain("*Attachments:* `a.txt`");
    expect(md).toContain('`search` {"q":"x"} - failed: timeout (12 ms)');
    expect(md.endsWith("\n")).toBe(true);
  });

  it("renders JSON that can be read back", () => {
    const json = JSON.parse(renderJson(transcript([message("user", "hi"), message("assistant", "yo", { metadata: { status: "completed", feedback: { rating: "up", createdAt: "x", updatedAt: "x" } } })])));
    expect(json.schemaVersion).toBe(1);
    expect(json.conversation).toMatchObject({ id: "conv_1", title: "Plan", agentName: "Helper" });
    expect(json.messages[1]).toMatchObject({ role: "assistant", content: "yo", status: "completed", feedback: { rating: "up", reasons: [], comment: null } });
  });

  it("renders HTML in which every message is text and the policy allows no network", () => {
    const html = renderHtml(transcript([message("user", '<b onmouseover="x">hi</b>'), message("assistant", "a & b")]), { lang: '"><script>' });
    expect(html).not.toContain("<b ");
    expect(html).toContain("&lt;b onmouseover=&quot;x&quot;&gt;hi&lt;/b&gt;");
    expect(html).toContain("a &amp; b");
    expect(html).toContain('lang="&quot;&gt;&lt;script&gt;"');
    expect(html).toContain('http-equiv="Content-Security-Policy"');
    expect(htmlContentSecurityPolicy(false)).not.toContain("script-src");
    expect(htmlContentSecurityPolicy(true)).toMatch(/script-src 'sha256-/);
    expect(htmlContentSecurityPolicy(false)).toContain("default-src 'none'");
  });
});

describe("tool calls of an export", () => {
  const msg = (id: string, role: Message["role"], content: string): Message => ({
    id,
    conversationId: "conv_1",
    role,
    content,
    createdAt: new Date("2026-10-11T10:00:00.000Z"),
    updatedAt: new Date("2026-10-11T10:00:00.000Z"),
  });
  /** user, answer (searched), user, answer (nothing), user, answer (two tools, one failed) */
  const history = [msg("u1", "user", "q1"), msg("a1", "assistant", "r1"), msg("u2", "user", "q2"), msg("a2", "assistant", "r2"), msg("u3", "user", "q3"), msg("a3", "assistant", "r3")];

  /** A log in the order this server writes it, snake_case and with a run on every event. */
  function serverLog(): ToolLogEvent[] {
    let seq = 0;
    const e = (type: string, data: Record<string, unknown>, runId?: string): ToolLogEvent => ({ seq: ++seq, type, data, ...(runId ? { runId } : {}) });
    return [
      e("user.message", { content: "q1", message_id: "u1" }, "run_1"),
      e("agent.tool_use", { tool_call_id: "c1", name: "search", args: { q: "x" } }, "run_1"),
      e("agent.tool_result", { tool_call_id: "c1", name: "search", ok: true, duration_ms: 7 }, "run_1"),
      e("agent.message", { content: "r1", message_id: "a1" }, "run_1"),
      e("user.message", { content: "q2", message_id: "u2" }, "run_2"),
      e("agent.message", { content: "r2", message_id: "a2" }, "run_2"),
      e("user.message", { content: "q3", message_id: "u3" }, "run_3"),
      e("agent.tool_use", { tool_call_id: "c2", name: "fetch", args: {} }, "run_3"),
      e("agent.tool_use", { tool_call_id: "c3", name: "write", args: { path: "a" } }, "run_3"),
      e("agent.tool_result", { tool_call_id: "c2", name: "fetch", ok: false, error: "timeout" }, "run_3"),
      e("agent.tool_result", { tool_call_id: "c3", name: "write", ok: true }, "run_3"),
      e("agent.message", { content: "r3", message_id: "a3" }, "run_3"),
    ];
  }
  const search = { name: "search", args: { q: "x" }, ok: true, durationMs: 7 };
  const fetchFailed = { name: "fetch", args: {}, ok: false, error: "timeout" };
  const write = { name: "write", args: { path: "a" }, ok: true };
  const expected = () => new Map([["a1", [search]], ["a3", [fetchFailed, write]]]);

  /** The log of a host that keeps its own: camelCase, and no run (and, as asked, no message id or index). */
  const hostLog = (options: { ids?: boolean; index?: boolean; bare?: boolean } = {}): ToolLogEvent[] => {
    const indexOf: Record<string, number> = { a1: 1, a2: 3, a3: 5 };
    return serverLog().map(({ runId: _run, ...event }) => {
      const data = Object.fromEntries(
        Object.entries(event.data).map(([key, value]) => [key.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase()), value])
      );
      if (event.type === "agent.message") {
        const id = data.messageId as string;
        delete data.messageId;
        if (options.bare) delete data.content;
        return { ...event, data: { ...data, ...(options.ids ? { messageId: id } : {}), ...(options.index ? { messageIndex: indexOf[id] } : {}) } };
      }
      if (event.type === "user.message") delete data.messageId;
      return { ...event, data };
    });
  };

  it("matches the calls of a run to the answer that names the run", () => {
    expect(toolCallsByAnswer(serverLog(), history)).toEqual(expected());
  });

  it("matches calls of events without a run by the id of the answer", () => {
    expect(toolCallsByAnswer(hostLog({ ids: true }), history)).toEqual(expected());
  });

  it("matches a host's own log (camelCase, no run, no id) by the position its answer reports", () => {
    expect(toolCallsByAnswer(hostLog({ index: true }), history)).toEqual(expected());
  });

  it("matches a host's log by what each answer says when it reports no id and no position", () => {
    expect(toolCallsByAnswer(hostLog(), history)).toEqual(expected());
    // an event that was cut to its size limit
    const cut = hostLog().map((event) => (event.type === "agent.message" && event.data.content === "r3" ? { ...event, data: { content: "r...", _truncated: true } } : event));
    expect(toolCallsByAnswer(cut, history)).toEqual(expected());
  });

  it("matches a log that says nothing but the order, from the newest answer back", () => {
    expect(toolCallsByAnswer(hostLog({ bare: true }), history)).toEqual(expected());
  });

  it("trusts the position over the words only while the words fit", () => {
    // the host rewrote the text of its answers: the position it reports is all there is
    const rewritten = history.map((m) => (m.role === "assistant" ? { ...m, content: `${m.content}!` } : m));
    expect(toolCallsByAnswer(hostLog({ index: true }), rewritten)).toEqual(expected());
    // the transcript was cut back: the position now points at another answer, the words at the right one
    const shifted = [msg("x1", "user", "z"), msg("x2", "assistant", "other"), ...history];
    expect(toolCallsByAnswer(hostLog({ index: true }), shifted)).toEqual(expected());
  });

  it("does not hand the calls of a pruned turn to another answer", () => {
    // the log lost its oldest events: the first turn's calls are gone, the others keep their answers
    const pruned = hostLog({ bare: true }).slice(6);
    expect(toolCallsByAnswer(pruned, history)).toEqual(new Map([["a3", [fetchFailed, write]]]));
    expect(toolCallsByAnswer(hostLog().slice(6), history)).toEqual(new Map([["a3", [fetchFailed, write]]]));
    // ... and so does a log that kept an answer which has been regenerated away
    const regenerated = history.filter((m) => m.id !== "a3").concat(msg("a3b", "assistant", "r3 again"));
    const again = hostLog();
    again.push({ seq: 99, type: "agent.tool_use", data: { toolCallId: "c9", name: "retry", args: {} } }, { seq: 100, type: "agent.message", data: { content: "r3 again" } });
    expect(toolCallsByAnswer(again, regenerated)).toEqual(new Map([["a1", [search]], ["a3b", [{ name: "retry", args: {} }]]]));
    // (the stale answer is not handed to a neighbour)
    expect([...toolCallsByAnswer(again, regenerated).keys()]).not.toContain("a2");
  });

  it("leaves out the calls of a turn that never answered", () => {
    const log = hostLog();
    // a stopped turn: a call, no answer; then the next question gets its own
    log.splice(4, 0, { seq: 50, type: "agent.tool_use", data: { toolCallId: "stray", name: "stray", args: {} } });
    const found = toolCallsByAnswer(log, history);
    expect(JSON.stringify([...found.values()])).not.toContain("stray");
    expect(found.get("a1")).toEqual([search]);
  });

  it("keeps a call that was asked before a pause and answered after it", () => {
    const log: ToolLogEvent[] = [
      { seq: 1, type: "user.message", data: { content: "q" } },
      { seq: 2, type: "agent.tool_use", data: { toolCallId: "c1", name: "deploy", args: { env: "x" } } },
      { seq: 3, type: "session.status_idle", data: { stopReason: "requires_action" } },
      { seq: 4, type: "agent.tool_result", data: { toolCallId: "c1", name: "deploy", ok: true } },
      { seq: 5, type: "agent.message", data: { content: "done", messageIndex: 1 } },
    ];
    expect(toolCallsByAnswer(log, [msg("u", "user", "q"), msg("a", "assistant", "done")])).toEqual(new Map([["a", [{ name: "deploy", args: { env: "x" }, ok: true }]]]));
  });

  it("answers nothing for a log without calls, and for events of a conversation that has no such answers", () => {
    expect(toolCallsByAnswer([], history).size).toBe(0);
    expect(toolCallsByAnswer(hostLog({ ids: true }), [msg("u1", "user", "q")]).size).toBe(0);
  });
});
