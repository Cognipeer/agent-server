/**
 * Generated conversation titles: after the first answer of a conversation that has no title, a model is asked for a short one.
 * Either an OpenAI-compatible endpoint (`baseUrl` + `model`) or the host's own `generate` function.
 */

import { normalizeUsage } from "./usage.js";
import type { AgentInfo, Conversation, PricingFn, RequestContext, TitleGenerationConfig, TitleResult, UsageInfo } from "./types.js";

export const DEFAULT_TITLE_WORDS = 6;
export const DEFAULT_TITLE_TIMEOUT_MS = 10_000;
/** A title longer than this is cut, whatever the word count says. */
export const MAX_TITLE_CHARS = 120;
/** How much of the first user message / answer a model reads for the title. */
const MAX_PROMPT_CHARS = 1500;

/** A title in the form it is stored: quotes and markup the model wrapped around it removed, cut to `maxWords` words and {@link MAX_TITLE_CHARS} characters. */
export function cleanTitle(raw: unknown, maxWords = DEFAULT_TITLE_WORDS): string | undefined {
  if (typeof raw !== "string") return undefined;
  let text = raw.replace(/\r?\n+/g, " ").trim();
  // The first line is the title; "Title: ..." prefixes and Markdown decoration are not
  text = text.replace(/^(?:title|başlık)\s*:\s*/i, "").replace(/^[#>*_`\s]+|[*_`\s]+$/g, "");
  text = text.replace(/^["'“”‘’«»„]+|["'“”‘’«»„]+$/g, "").trim();
  text = text.replace(/[.。]+$/, "").replace(/\s+/g, " ");
  if (!text) return undefined;
  const words = text.split(" ");
  const limit = Number.isFinite(maxWords) && maxWords >= 1 ? Math.floor(maxWords) : DEFAULT_TITLE_WORDS;
  if (words.length > limit) text = words.slice(0, limit).join(" ");
  if (text.length > MAX_TITLE_CHARS) text = text.slice(0, MAX_TITLE_CHARS).trimEnd();
  return text || undefined;
}

/** Throws when a title configuration cannot work (no way to make a title), at registration and not at the first answer. */
export function assertTitleGeneration(cfg: TitleGenerationConfig | false | undefined, where: string): void {
  if (cfg === undefined || cfg === false) return;
  if (!cfg || typeof cfg !== "object") throw new Error(`${where} has to be an object (or false)`);
  if (cfg.generate !== undefined && typeof cfg.generate !== "function") throw new Error(`${where}.generate has to be a function`);
  if (!cfg.generate && (!cfg.baseUrl || !cfg.model)) {
    throw new Error(`${where} needs baseUrl and model (an OpenAI-compatible endpoint), or a generate function`);
  }
  if (cfg.maxWords !== undefined && (!Number.isFinite(cfg.maxWords) || cfg.maxWords < 1)) {
    throw new Error(`${where}.maxWords has to be at least 1`);
  }
}

export function titleWords(cfg: TitleGenerationConfig): number {
  return cfg.maxWords !== undefined && Number.isFinite(cfg.maxWords) && cfg.maxWords >= 1 ? Math.floor(cfg.maxWords) : DEFAULT_TITLE_WORDS;
}

const clip = (text: string) => (text.length > MAX_PROMPT_CHARS ? `${text.slice(0, MAX_PROMPT_CHARS)}...` : text);

/** The instructions a model is given. */
export function titlePrompt(cfg: TitleGenerationConfig, user: string, assistant?: string): string {
  const words = titleWords(cfg);
  return (
    `Write a title for the conversation below: at most ${words} words, written in the same language as the user's message. ` +
    `Return only the title - no quotes, no punctuation at the end, no extra text.` +
    (cfg.instructions ? `\n${cfg.instructions}` : "") +
    `\n\nUser message:\n${clip(user)}` +
    (assistant ? `\n\nAssistant answer:\n${clip(assistant)}` : "")
  );
}

export interface GeneratedTitle {
  title: string;
  usage?: UsageInfo;
  model?: string;
}

/**
 * Asks for a title. Resolves `undefined` when none could be made (the call failed, timed out, was cancelled or the model said
 * nothing usable) - the conversation then simply has no generated title.
 */
export async function generateConversationTitle(
  cfg: TitleGenerationConfig,
  input: {
    conversation: Conversation;
    agent: AgentInfo;
    user: string;
    assistant?: string;
    context: RequestContext;
    pricing?: PricingFn;
    signal?: AbortSignal;
  }
): Promise<GeneratedTitle | undefined> {
  const maxWords = titleWords(cfg);
  // Bounded: the call gives up after `timeoutMs` and when the run is cancelled (the turn holds the conversation while it waits)
  const controller = new AbortController();
  const abort = () => controller.abort();
  const timer = setTimeout(abort, typeof cfg.timeoutMs === "number" && cfg.timeoutMs > 0 ? cfg.timeoutMs : DEFAULT_TITLE_TIMEOUT_MS);
  if (input.signal?.aborted) abort();
  else input.signal?.addEventListener("abort", abort, { once: true });
  const assistant = cfg.includeAnswer === false ? undefined : input.assistant;
  try {
    if (cfg.generate) {
      const generated = await raceAbort(
        Promise.resolve(
          cfg.generate({
            conversation: input.conversation,
            agent: input.agent,
            user: input.user,
            assistant,
            maxWords,
            context: input.context,
            signal: controller.signal,
          })
        ),
        controller.signal
      );
      const result: TitleResult | undefined =
        typeof generated === "string" ? { title: generated } : generated && typeof generated === "object" ? generated : undefined;
      const title = cleanTitle(result?.title, maxWords);
      if (!title) return undefined;
      const usage = result?.usage ? normalizeUsage(result.usage, { pricing: input.pricing, model: result.model }) : undefined;
      return { title, ...(usage ? { usage } : {}), ...(result?.model ? { model: result.model } : {}) };
    }

    const res = await fetch(`${cfg.baseUrl!.replace(/\/$/, "")}${cfg.path ?? "/v1/chat/completions"}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: cfg.model,
        messages: [{ role: "user", content: titlePrompt(cfg, input.user, assistant) }],
        temperature: 0.5,
        max_tokens: Math.max(24, maxWords * 8),
      }),
      signal: controller.signal,
    });
    if (!res.ok) return undefined;
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: unknown;
      model?: string;
    };
    const title = cleanTitle(data.choices?.[0]?.message?.content, maxWords);
    if (!title) return undefined;
    const usage = normalizeUsage(data.usage, { pricing: input.pricing, model: cfg.model });
    return { title, ...(usage ? { usage } : {}), model: cfg.model };
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener("abort", abort);
  }
}

/** `work`, or a rejection when the signal aborts first (a generator that ignores the signal is not waited for). */
function raceAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error("title generation was cancelled"));
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      }
    );
  });
}
