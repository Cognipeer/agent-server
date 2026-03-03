/**
 * Chat Completions API Provider
 *
 * OpenAI-compatible Chat Completions API (/v1/chat/completions) üzerinden
 * agent çalıştırmak için kullanılır. OpenAI, Azure OpenAI, Anthropic (uyumlu),
 * veya herhangi bir OpenAI-compatible endpoint ile çalışır.
 */

// ============================================================================
// Types
// ============================================================================

export interface ChatCompletionsConfig {
  /** Base URL of the API (e.g., "https://api.openai.com") */
  baseUrl: string;

  /** API key for authentication */
  apiKey: string;

  /** Model name (e.g., "gpt-4o", "gpt-3.5-turbo", "claude-3-opus") */
  model: string;

  /** System prompt to prepend to conversations */
  systemPrompt?: string;

  /** Temperature for generation (0-2) */
  temperature?: number;

  /** Maximum tokens in response */
  maxTokens?: number;

  /** API path override (default: "/v1/chat/completions") */
  path?: string;

  /** Additional headers to send with requests */
  headers?: Record<string, string>;

  /** Additional body parameters to merge into every request */
  extraBody?: Record<string, unknown>;
}

interface ChatCompletionsMessage {
  role: string;
  content: string;
  tool_calls?: Array<{
    id: string;
    type: string;
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
  name?: string;
}

interface ChatCompletionsRequest {
  model: string;
  messages: ChatCompletionsMessage[];
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
  [key: string]: unknown;
}

interface ChatCompletionsResponse {
  id: string;
  choices: Array<{
    index: number;
    message: {
      role: string;
      content: string | null;
      tool_calls?: Array<{
        id: string;
        type: string;
        function: { name: string; arguments: string };
      }>;
    };
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

interface ChatCompletionsStreamChunk {
  id: string;
  choices: Array<{
    index: number;
    delta: {
      role?: string;
      content?: string | null;
    };
    finish_reason: string | null;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface ChatCompletionsResult {
  content: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
}

export type ChatCompletionsStreamEvent =
  | { type: "text"; text: string }
  | {
      type: "done";
      content: string;
      usage?: {
        inputTokens: number;
        outputTokens: number;
        totalTokens: number;
      };
    };

// ============================================================================
// Implementation
// ============================================================================

function buildUrl(config: ChatCompletionsConfig): string {
  return `${config.baseUrl.replace(/\/$/, "")}${config.path || "/v1/chat/completions"}`;
}

function buildHeaders(config: ChatCompletionsConfig): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${config.apiKey}`,
    ...config.headers,
  };
}

function buildMessages(
  config: ChatCompletionsConfig,
  messages: ChatCompletionsMessage[]
): ChatCompletionsMessage[] {
  const allMessages: ChatCompletionsMessage[] = [];
  if (config.systemPrompt) {
    allMessages.push({ role: "system", content: config.systemPrompt });
  }
  allMessages.push(...messages);
  return allMessages;
}

/**
 * Invoke Chat Completions API (non-streaming)
 */
export async function invokeChatCompletions(
  config: ChatCompletionsConfig,
  messages: ChatCompletionsMessage[]
): Promise<ChatCompletionsResult> {
  const url = buildUrl(config);
  const allMessages = buildMessages(config, messages);

  const requestBody: ChatCompletionsRequest = {
    model: config.model,
    messages: allMessages,
    ...(config.temperature !== undefined && { temperature: config.temperature }),
    ...(config.maxTokens !== undefined && { max_tokens: config.maxTokens }),
    ...config.extraBody,
  };

  const response = await fetch(url, {
    method: "POST",
    headers: buildHeaders(config),
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Chat Completions API error (${response.status}): ${errorText}`
    );
  }

  const data = (await response.json()) as ChatCompletionsResponse;
  const content = data.choices?.[0]?.message?.content || "";

  return {
    content,
    usage: data.usage
      ? {
          inputTokens: data.usage.prompt_tokens,
          outputTokens: data.usage.completion_tokens,
          totalTokens: data.usage.total_tokens,
        }
      : undefined,
  };
}

/**
 * Stream Chat Completions API via SSE
 */
export async function* streamChatCompletions(
  config: ChatCompletionsConfig,
  messages: ChatCompletionsMessage[]
): AsyncGenerator<ChatCompletionsStreamEvent, void, unknown> {
  const url = buildUrl(config);
  const allMessages = buildMessages(config, messages);

  const requestBody: ChatCompletionsRequest = {
    model: config.model,
    messages: allMessages,
    stream: true,
    ...(config.temperature !== undefined && { temperature: config.temperature }),
    ...(config.maxTokens !== undefined && { max_tokens: config.maxTokens }),
    ...config.extraBody,
  };

  const response = await fetch(url, {
    method: "POST",
    headers: buildHeaders(config),
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Chat Completions API error (${response.status}): ${errorText}`
    );
  }

  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("No response body for streaming");
  }

  const decoder = new TextDecoder();
  let buffer = "";
  let fullContent = "";
  let lastUsage:
    | { inputTokens: number; outputTokens: number; totalTokens: number }
    | undefined;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("data: ")) continue;

        const data = trimmed.slice(6);
        if (data === "[DONE]") {
          yield {
            type: "done" as const,
            content: fullContent,
            usage: lastUsage,
          };
          return;
        }

        try {
          const chunk = JSON.parse(data) as ChatCompletionsStreamChunk;
          const content = chunk.choices?.[0]?.delta?.content;
          if (content) {
            fullContent += content;
            yield { type: "text" as const, text: content };
          }
          // Some providers send usage in the last chunk
          if (chunk.usage) {
            lastUsage = {
              inputTokens: chunk.usage.prompt_tokens,
              outputTokens: chunk.usage.completion_tokens,
              totalTokens: chunk.usage.total_tokens,
            };
          }
        } catch {
          // Skip unparseable chunks
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  yield {
    type: "done" as const,
    content: fullContent,
    usage: lastUsage,
  };
}
