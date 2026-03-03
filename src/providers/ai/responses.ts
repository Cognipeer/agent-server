/**
 * OpenAI Responses API Provider
 *
 * OpenAI Responses API (/v1/responses) üzerinden agent çalıştırmak için kullanılır.
 * Bu API, OpenAI'ın yeni nesil API'sidir ve multi-turn conversations,
 * built-in tools (web search, file search, code interpreter) destekler.
 */

// ============================================================================
// Types
// ============================================================================

export interface ResponsesApiConfig {
  /** Base URL of the API (e.g., "https://api.openai.com") */
  baseUrl: string;

  /** API key for authentication */
  apiKey: string;

  /** Model name (e.g., "gpt-4o", "gpt-4o-mini", "o1") */
  model: string;

  /** Instructions (system prompt) for the model */
  instructions?: string;

  /** Temperature for generation (0-2) */
  temperature?: number;

  /** Maximum output tokens */
  maxOutputTokens?: number;

  /** API path override (default: "/v1/responses") */
  path?: string;

  /** Additional headers to send with requests */
  headers?: Record<string, string>;

  /**
   * Tools configuration for the Responses API
   * Examples: [{ type: "web_search_preview" }, { type: "code_interpreter" }]
   */
  tools?: unknown[];

  /** Additional body parameters to merge into every request */
  extraBody?: Record<string, unknown>;
}

interface ResponsesApiInputMessage {
  role: string;
  content:
    | string
    | Array<{ type: string; text?: string; [key: string]: unknown }>;
}

interface ResponsesApiRequest {
  model: string;
  input: string | ResponsesApiInputMessage[];
  instructions?: string;
  temperature?: number;
  max_output_tokens?: number;
  stream?: boolean;
  tools?: unknown[];
  previous_response_id?: string;
  [key: string]: unknown;
}

interface ResponsesApiResponse {
  id: string;
  output: Array<{
    type: string;
    id?: string;
    role?: string;
    status?: string;
    content?: Array<{
      type: string;
      text?: string;
      annotations?: unknown[];
      [key: string]: unknown;
    }>;
    [key: string]: unknown;
  }>;
  usage?: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
  };
}

export interface ResponsesApiResult {
  content: string;
  responseId: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
}

export type ResponsesApiStreamEvent =
  | { type: "text"; text: string }
  | {
      type: "done";
      responseId: string;
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

function buildUrl(config: ResponsesApiConfig): string {
  return `${config.baseUrl.replace(/\/$/, "")}${config.path || "/v1/responses"}`;
}

function buildHeaders(config: ResponsesApiConfig): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${config.apiKey}`,
    ...config.headers,
  };
}

function buildInput(
  messages: Array<{ role: string; content: string }>
): ResponsesApiInputMessage[] {
  return messages.map((m) => ({
    role: m.role === "assistant" ? "assistant" : m.role === "system" ? "developer" : "user",
    content: m.content,
  }));
}

/**
 * Extract text content from Responses API output
 */
function extractContent(output: ResponsesApiResponse["output"]): string {
  const parts: string[] = [];
  for (const item of output) {
    if (item.type === "message" && item.content) {
      for (const part of item.content) {
        if (part.type === "output_text" && part.text) {
          parts.push(part.text);
        }
      }
    }
  }
  return parts.join("");
}

/**
 * Invoke Responses API (non-streaming)
 */
export async function invokeResponsesApi(
  config: ResponsesApiConfig,
  messages: Array<{ role: string; content: string }>,
  previousResponseId?: string
): Promise<ResponsesApiResult> {
  const url = buildUrl(config);
  const input = buildInput(messages);

  const requestBody: ResponsesApiRequest = {
    model: config.model,
    input,
    ...(config.instructions && { instructions: config.instructions }),
    ...(config.temperature !== undefined && {
      temperature: config.temperature,
    }),
    ...(config.maxOutputTokens !== undefined && {
      max_output_tokens: config.maxOutputTokens,
    }),
    ...(config.tools && config.tools.length > 0 && { tools: config.tools }),
    ...(previousResponseId && {
      previous_response_id: previousResponseId,
    }),
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
      `Responses API error (${response.status}): ${errorText}`
    );
  }

  const data = (await response.json()) as ResponsesApiResponse;
  const content = extractContent(data.output);

  return {
    content,
    responseId: data.id,
    usage: data.usage
      ? {
          inputTokens: data.usage.input_tokens,
          outputTokens: data.usage.output_tokens,
          totalTokens: data.usage.total_tokens,
        }
      : undefined,
  };
}

/**
 * Stream Responses API via SSE
 *
 * Responses API stream events:
 * - response.output_text.delta → text chunks
 * - response.completed → final response with usage
 */
export async function* streamResponsesApi(
  config: ResponsesApiConfig,
  messages: Array<{ role: string; content: string }>,
  previousResponseId?: string
): AsyncGenerator<ResponsesApiStreamEvent, void, unknown> {
  const url = buildUrl(config);
  const input = buildInput(messages);

  const requestBody: ResponsesApiRequest = {
    model: config.model,
    input,
    stream: true,
    ...(config.instructions && { instructions: config.instructions }),
    ...(config.temperature !== undefined && {
      temperature: config.temperature,
    }),
    ...(config.maxOutputTokens !== undefined && {
      max_output_tokens: config.maxOutputTokens,
    }),
    ...(config.tools && config.tools.length > 0 && { tools: config.tools }),
    ...(previousResponseId && {
      previous_response_id: previousResponseId,
    }),
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
      `Responses API error (${response.status}): ${errorText}`
    );
  }

  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("No response body for streaming");
  }

  const decoder = new TextDecoder();
  let buffer = "";
  let fullContent = "";
  let responseId = "";
  let usage:
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
        if (!trimmed) continue;

        // Responses API events: "event: <type>\ndata: <json>"
        // We only care about data lines
        if (trimmed.startsWith("event:")) continue;
        if (!trimmed.startsWith("data: ")) continue;

        const data = trimmed.slice(6);
        try {
          const event = JSON.parse(data);

          if (event.type === "response.output_text.delta") {
            const text = event.delta || "";
            if (text) {
              fullContent += text;
              yield { type: "text" as const, text };
            }
          } else if (event.type === "response.completed") {
            responseId = event.response?.id || "";
            // Extract full content from completed response if available
            if (event.response?.output) {
              const completedContent = extractContent(event.response.output);
              if (completedContent && !fullContent) {
                fullContent = completedContent;
              }
            }
            if (event.response?.usage) {
              usage = {
                inputTokens: event.response.usage.input_tokens,
                outputTokens: event.response.usage.output_tokens,
                totalTokens: event.response.usage.total_tokens,
              };
            }
          }
        } catch {
          // Skip unparseable events
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  yield {
    type: "done" as const,
    responseId,
    content: fullContent,
    usage,
  };
}
