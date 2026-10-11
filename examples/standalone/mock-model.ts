/**
 * A scripted chat model, so the example (and an end-to-end test of it) runs without an API key. It decides what to do from the
 * last message:
 *
 *   "deploy <service>"   calls `deploy_service`, which needs a person's approval
 *   "ask ..."            calls `ask_user_question` (pick an environment)
 *   "files" / "attached" calls `session_files_list`, then reads the first file with `session_files_read`
 *   "slow ..."           answers after a few seconds (long enough to cancel it, reload the page or follow the run)
 *   anything else        answers `You said: "<message>"`, word by word when streaming
 *
 * After a tool has answered it says so. It reports token counts (about four characters a token) so usage, cost and budgets show up.
 * Point `LLM_BASE_URL` at a real OpenAI-compatible API instead and none of this is used.
 */

type Part = { type?: string; text?: string; [key: string]: unknown };
type Message = { role: string; content?: string | Part[]; name?: string; tool_call_id?: string; [key: string]: unknown };

export const MOCK_MODEL_NAME = "mock-llm";

const textOf = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? (content as Part[]).filter((part) => part?.type === "text" || typeof part?.text === "string").map((part) => part.text ?? "").join("\n")
      : "";

const tokens = (text: string) => Math.max(1, Math.ceil(text.length / 4));

type Plan = { text: string; tool?: undefined } | { tool: { name: string; args: Record<string, unknown> }; text?: undefined };

function plan(messages: Message[], toolNames: Set<string>): Plan {
  const last = messages[messages.length - 1];
  if (last?.role === "tool") {
    const name = last.name ?? "the tool";
    const full = textOf(last.content);
    const result = full.slice(0, 300);
    if (name === "session_files_list") {
      const first = /"fileId"\s*:\s*"([^"]+)"/.exec(full)?.[1];
      if (first && toolNames.has("session_files_read")) return { tool: { name: "session_files_read", args: { fileId: first } } };
      return { text: first ? `Files: ${result}` : "The conversation holds no files yet." };
    }
    if (name === "session_files_read") {
      let text = full;
      try {
        text = String((JSON.parse(full) as { text?: unknown }).text ?? full);
      } catch {
        // (not JSON: say it as it is)
      }
      return { text: `The file says: ${text.replace(/\s+/g, " ").slice(0, 200)}` };
    }
    if (name === "ask_user_question") return { text: `Thanks. I will go with: ${result}` };
    return { text: `Done. ${name} said: ${result}` };
  }

  // The newest user message (a tool result comes after it)
  const user = textOf([...messages].reverse().find((m) => m.role === "user")?.content);
  const deploy = /\bdeploy\s+([\w.-]+)/i.exec(user);
  if (deploy && toolNames.has("deploy_service")) {
    return { tool: { name: "deploy_service", args: { service: deploy[1], version: "1.0.0" } } };
  }
  if (/\bask\b/i.test(user) && toolNames.has("ask_user_question")) {
    return {
      tool: {
        name: "ask_user_question",
        args: { questions: [{ question: "Which environment?", header: "Env", options: [{ label: "staging" }, { label: "production" }] }] },
      },
    };
  }
  if (/\b(files?|attached|attachment)\b/i.test(user) && toolNames.has("session_files_list")) {
    return { tool: { name: "session_files_list", args: {} } };
  }
  return { text: `You said: "${user.slice(0, 500)}"` };
}

const wait = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true }
    );
  });

/** What a real HTTP client does when its request is aborted. */
const abortError = () => Object.assign(new Error("The operation was aborted"), { name: "AbortError" });

export interface MockModelOptions {
  /** How long a "slow" message takes, in milliseconds. */
  slowMs?: number;
  /** Pause between streamed words, in milliseconds. */
  wordDelayMs?: number;
}

export function mockModel(options: MockModelOptions = {}) {
  const slowMs = options.slowMs ?? 4000;
  const wordDelayMs = options.wordDelayMs ?? 15;
  const toolNames = new Set<string>();

  const respond = (messages: Message[]) => {
    const decided = plan(messages, toolNames);
    const prompt = messages.map((m) => textOf(m.content)).join(" ");
    const usage = (answer: string) => ({
      input_tokens: tokens(prompt),
      output_tokens: tokens(answer),
      total_tokens: tokens(prompt) + tokens(answer),
    });
    const message = decided.tool
      ? {
          role: "assistant",
          content: "",
          tool_calls: [
            { id: `call_${Math.random().toString(36).slice(2, 10)}`, type: "function", function: { name: decided.tool.name, arguments: JSON.stringify(decided.tool.args) } },
          ],
          usage_metadata: usage(JSON.stringify(decided.tool.args)),
        }
      : { role: "assistant", content: decided.text, usage_metadata: usage(decided.text) };
    const slow = /\bslow\b/i.test(textOf([...messages].reverse().find((m) => m.role === "user")?.content)) && messages[messages.length - 1]?.role !== "tool";
    return { message, slow };
  };

  const model: Record<string, unknown> = {
    modelName: MOCK_MODEL_NAME,
    bindTools(tools: Array<{ name?: string; function?: { name?: string } }>) {
      for (const tool of tools ?? []) {
        const name = tool?.name ?? tool?.function?.name;
        if (name) toolNames.add(name);
      }
      return model;
    },
    async invoke(messages: Message[], options?: { signal?: AbortSignal }) {
      const { message, slow } = respond(messages);
      if (slow) await wait(slowMs, options?.signal);
      if (options?.signal?.aborted) throw abortError();
      return message;
    },
    // Words as they are "thought", then the whole message (the SDK takes the last role-bearing chunk as the answer)
    async *stream(messages: Message[], options?: { signal?: AbortSignal }) {
      const { message, slow } = respond(messages);
      if (slow) await wait(slowMs, options?.signal);
      const text = typeof message.content === "string" ? message.content : "";
      for (const word of text.split(/(\s+)/)) {
        if (options?.signal?.aborted) throw abortError();
        if (word === "") continue;
        yield word;
        await wait(wordDelayMs, options?.signal);
      }
      yield message;
    },
  };
  return model;
}

/** What the mock costs, so `spentUsd` and budgets can be tried: a dollar per million input tokens, two per million output. */
export const examplePricing = (model: string) =>
  model === MOCK_MODEL_NAME ? { inputPerToken: 1e-6, outputPerToken: 2e-6 } : undefined;
