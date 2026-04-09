# AI Providers

Agent Server can expose more than SDK agents. It also knows how to register provider-backed agents directly through two built-in runtime surfaces:

- OpenAI-compatible Chat Completions
- OpenAI Responses API

That gives you a path to serve remote model-backed agents without first wrapping everything in `@cognipeer/agent-sdk`.

## When this feature is useful

Use provider-backed registration when:

- you already have an OpenAI-compatible endpoint and want to expose it as an agent quickly
- you need a lightweight server integration before adopting a richer SDK runtime
- you want built-in Responses API features such as tools or response chaining
- you want a consistent REST surface while the actual model backend stays configurable

## Chat Completions agents

`registerChatCompletionsAgent(...)` connects an agent id to any OpenAI-compatible `/v1/chat/completions` endpoint.

The provider config supports:

- `baseUrl`
- `apiKey`
- `model`
- optional `systemPrompt`
- optional `temperature`
- optional `maxTokens`
- optional path override
- optional extra headers
- optional extra body fields

Typical use cases:

- OpenAI or Azure OpenAI
- proxy gateways that expose an OpenAI-compatible path
- internal inference services that mirror Chat Completions behavior

```ts
server.registerChatCompletionsAgent(
  'support-bot',
  {
    baseUrl: 'https://api.openai.com',
    apiKey: process.env.OPENAI_API_KEY!,
    model: 'gpt-4o-mini',
    systemPrompt: 'You are a concise support assistant.',
  },
  {
    name: 'Support Bot',
    description: 'Chat Completions backed support agent',
  }
);
```

## Responses API agents

`registerResponsesAgent(...)` connects an agent id to an OpenAI-style `/v1/responses` endpoint.

This config supports:

- `baseUrl`
- `apiKey`
- `model`
- optional `instructions`
- optional `temperature`
- optional `maxOutputTokens`
- optional path override
- optional extra headers
- optional `tools`
- optional extra body fields

This path is useful when you want the newer Responses model interaction style, including built-in tool declarations such as web search or code interpreter.

```ts
server.registerResponsesAgent(
  'research-bot',
  {
    baseUrl: 'https://api.openai.com',
    apiKey: process.env.OPENAI_API_KEY!,
    model: 'gpt-4o',
    instructions: 'You are a research assistant.',
    tools: [{ type: 'web_search_preview' }],
  },
  {
    name: 'Research Bot',
    description: 'Responses API backed agent',
  }
);
```

## Runtime differences that matter

| Concern | Chat Completions | Responses API |
| --- | --- | --- |
| Main endpoint | `/v1/chat/completions` | `/v1/responses` |
| System-level prompt field | `systemPrompt` | `instructions` |
| Token option | `maxTokens` | `maxOutputTokens` |
| Built-in tools config | Not part of this provider surface | Supported through `tools` |
| Response chaining | Standard message history replay | Supports `previous_response_id` chaining |

Choose the provider based on the backend contract you actually have, not on naming preference.

## How Agent Server uses them at message time

When a conversation message is sent, Agent Server:

1. loads the stored message history
2. normalizes messages into the provider-specific shape
3. invokes the selected provider
4. persists the assistant output back into the conversation transcript

For Responses API agents, the runtime also stores the returned `responseId` in conversation state as `lastResponseId`, so later turns can continue the chain.

## Streaming support

Both provider surfaces have streaming helpers inside the runtime:

- `streamChatCompletions(...)`
- `streamResponsesApi(...)`

Those helpers feed the same Agent Server SSE contract used by the `/messages` route when the request body includes `stream: true`.

That means your client integration can keep one streaming contract even if the underlying agent backend changes.

## How to choose

| If you need... | Start with... |
| --- | --- |
| broad compatibility with existing OpenAI-style gateways | Chat Completions |
| built-in Responses tools and response chaining | Responses API |
| the thinnest remote model wrapper | Chat Completions |
| a path closer to newer OpenAI response semantics | Responses API |

## Where to look next

- [Streaming](/guide/streaming) for SSE delivery behavior
- [Swagger UI](/guide/swagger) for the generated endpoint contract
- [API Reference](/api/server) for the core server surface
