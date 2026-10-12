# Custom Agents

Create custom agents without using the Agent SDK.

## Overview

While `@cognipeer/agent-sdk` provides a powerful agent framework, you can also integrate any AI backend using the custom agent interface.

## Agent Handler Interface

```typescript
interface AgentHandler {
  processMessage(params: ProcessMessageParams): Promise<ProcessMessageResult>;
  // Optional: continue a turn that paused for an approval / question
  resolveAction?(params: ResolveActionParams): Promise<ProcessMessageResult>;
}

interface ProcessMessageParams {
  conversationId: string;
  message: string;                       // what the person typed
  mode?: 'regenerate' | 'edit';          // set for a regeneration / an edit-and-resend (see "Chat experience"); absent for a new message
  fromMessageId?: string;                // the message `mode` started from
  files?: FileAttachment[];              // the files the message carries (real ids)
  state?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  context?: RequestContext;
  signal?: AbortSignal;                  // aborted when the run is cancelled
  getFileContent?: (fileId: string) => Promise<Buffer | null>;   // see "With File Processing"
  getFileText?: (fileId: string) => Promise<string | null>;
}

interface ProcessMessageResult {
  content: string;
  files?: FileAttachment[];
  state?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    costUsd?: number;   // what the turn cost: counts toward the conversation's budget (see "Usage & Budgets")
    model?: string;     // or name the model and let the server's `pricing` price the tokens
  };
  status?: 'completed' | 'requires_action' | 'incomplete' | 'cancelled';
  pendingActions?: PendingAction[];  // see "Approvals & Questions"; give one an `expiresAt` of its own, or the server stamps hitl.timeoutMinutes
}
```

`state` is yours: it replaces the visible state of the conversation, and the server's own bookkeeping (pause state, remembered tools, spend) is kept next to it whatever you return.

## Basic Example

```typescript
agentServer.registerCustomAgent('echo', {
  processMessage: async ({ message }) => ({
    content: `Echo: ${message}`,
  }),
}, {
  name: 'Echo Bot',
  description: 'A simple echo bot',
  version: '1.0.0',
});
```

## With OpenAI

```typescript
import OpenAI from 'openai';

const openai = new OpenAI();

agentServer.registerCustomAgent('gpt-assistant', {
  processMessage: async ({ message, state }) => {
    // Get conversation history from state
    const history = (state?.history as any[]) || [];
    
    // Add user message
    history.push({ role: 'user', content: message });
    
    // Call OpenAI
    const completion = await openai.chat.completions.create({
      model: 'gpt-4',
      messages: [
        { role: 'system', content: 'You are a helpful assistant.' },
        ...history,
      ],
    });
    
    const response = completion.choices[0].message.content;
    
    // Add assistant message to history
    history.push({ role: 'assistant', content: response });
    
    return {
      content: response,
      state: { history },
      usage: {
        inputTokens: completion.usage?.prompt_tokens,
        outputTokens: completion.usage?.completion_tokens,
        totalTokens: completion.usage?.total_tokens,
      },
    };
  },
}, {
  name: 'GPT Assistant',
  description: 'OpenAI GPT-4 powered assistant',
});
```

## With Anthropic

```typescript
import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic();

agentServer.registerCustomAgent('claude-assistant', {
  processMessage: async ({ message, state }) => {
    const history = (state?.history as any[]) || [];
    
    history.push({ role: 'user', content: message });
    
    const response = await anthropic.messages.create({
      model: 'claude-3-opus-20240229',
      max_tokens: 1024,
      messages: history,
    });
    
    const content = response.content[0].type === 'text' 
      ? response.content[0].text 
      : '';
    
    history.push({ role: 'assistant', content });
    
    return {
      content,
      state: { history },
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      },
    };
  },
}, {
  name: 'Claude Assistant',
  description: 'Anthropic Claude powered assistant',
});
```

## With File Processing

A message's files are in `files` (every entry has a real id, also for files sent inline), and two readers are scoped to the
conversation: `getFileContent(id)` gives the bytes, `getFileText(id)` the text the way an agent-sdk agent would be given it
(see [Files](./file-management.md)). Both answer `null` for an id that is not a file of this conversation or that expired.

```typescript
agentServer.registerCustomAgent('document-analyzer', {
  processMessage: async ({ message, files, getFileContent, getFileText }) => {
    if (!files || files.length === 0) {
      return { content: 'Please upload a document to analyze.' };
    }

    const results = [];

    for (const file of files) {
      if (file.mimeType.startsWith('image/')) {
        // Use vision API
        const bytes = await getFileContent!(file.id);
        const description = await analyzeImage(bytes!);
        results.push(`Image "${file.name}": ${description}`);
      } else {
        // PDF, Word, text ... converted when @cognipeer/to-markdown is installed (or by files.extractText)
        const text = await getFileText!(file.id);
        results.push(`"${file.name}": ${text ? text.slice(0, 500) + '...' : '(no text)'}`);
      }
    }

    return {
      content: `Analysis complete:\n\n${results.join('\n\n')}`,
    };
  },
}, { name: 'Document analyzer' }, {
  files: { allowedMimeTypes: ['application/pdf', 'image/*', 'text/*'], maxFileSize: 25 * 1024 * 1024 },
});
```

`message` is what the person typed; the server does not put the files' text into it for a custom handler.

## With State Management

```typescript
agentServer.registerCustomAgent('stateful-assistant', {
  processMessage: async ({ message, state, conversationId }) => {
    // Initialize state
    const currentState = {
      messageCount: (state?.messageCount as number) || 0,
      context: (state?.context as string[]) || [],
      lastTopic: state?.lastTopic as string,
    };
    
    // Update state
    currentState.messageCount++;
    currentState.context.push(message);
    
    // Keep only last 10 messages for context
    if (currentState.context.length > 10) {
      currentState.context = currentState.context.slice(-10);
    }
    
    // Process with context
    const response = await processWithContext(message, currentState);
    
    return {
      content: response.text,
      state: {
        ...currentState,
        lastTopic: response.topic,
      },
    };
  },
});
```

## Streaming

A handler answers once: a streamed request (`stream: true`) gets a progress frame and then the whole answer as one `stream.text`. An agent that streams its answer, reports its tool calls and
is cancelled through a signal is a **host-backed agent**: `registerHostAgent({ info, invoke })`, where `invoke` calls `emit({ type: 'text', text })` as it goes. See [Host-backed agents](./host-agents.md).

```typescript
agentServer.registerHostAgent({
  info: { id: 'streaming-agent', name: 'Streaming agent' },
  async invoke({ message }, { emit, signal }) {
    for (const chunk of ['Hello', ' there!', ' How', ' can', ' I', ' help?']) {
      if (signal.aborted) break;
      emit({ type: 'text', text: chunk });
      await delay(100); // Simulate processing
    }
    return {}; // the streamed text is the answer
  },
});
```

## OpenAI-compatible endpoints

An endpoint that speaks the Chat Completions or Responses API needs no handler:

```typescript
agentServer.registerChatCompletionsAgent('gpt', {
  baseUrl: 'https://api.openai.com',
  apiKey: process.env.OPENAI_API_KEY!,
  model: 'gpt-4o',
  systemPrompt: 'You are a helpful assistant.',
}, { name: 'GPT-4o' });

agentServer.registerResponsesAgent('resp', {
  baseUrl: 'https://api.openai.com',
  apiKey: process.env.OPENAI_API_KEY!,
  model: 'gpt-4o',
  instructions: 'You are a helpful assistant.',
  tools: [{ type: 'web_search_preview' }],
}, { name: 'GPT-4o Responses' });
```

They stream, accept attachments (text inline, pictures as `image_url` / `input_image` parts), are cancelled by aborting the upstream request, and count their usage; they never pause for an approval.

## With External APIs

```typescript
agentServer.registerCustomAgent('weather-bot', {
  processMessage: async ({ message }) => {
    // Extract location from message
    const location = extractLocation(message);
    
    if (!location) {
      return { content: 'Please specify a location for the weather forecast.' };
    }
    
    // Call weather API
    const weather = await fetch(
      `https://api.weather.com/v1/current?location=${location}`
    ).then(r => r.json());
    
    return {
      content: `The weather in ${location} is ${weather.conditions} ` +
               `with a temperature of ${weather.temperature}°C.`,
      metadata: { weatherData: weather },
    };
  },
}, {
  name: 'Weather Bot',
  description: 'Get current weather for any location',
  metadata: {
    capabilities: ['weather', 'forecast'],
    apiProvider: 'weather.com',
  },
});
```

## Error Handling

```typescript
agentServer.registerCustomAgent('robust-agent', {
  processMessage: async ({ message }) => {
    try {
      const result = await processMessage(message);
      return { content: result };
    } catch (error) {
      console.error('Agent error:', error);
      
      // Return user-friendly error
      return {
        content: 'I encountered an error processing your request. Please try again.',
        metadata: {
          error: error.message,
          errorCode: error.code,
        },
      };
    }
  },
});
```

## Agent Registration Options

```typescript
agentServer.registerCustomAgent('my-agent', handler, {
  // Display name
  name: 'My Custom Agent',
  
  // Description for documentation
  description: 'A custom AI agent',
  
  // Version string
  version: '1.0.0',
  
  // Custom metadata
  metadata: {
    capabilities: ['chat', 'analysis'],
    model: 'custom',
    maxTokens: 4096,
  },
});
```

## Testing Custom Agents

```typescript
import { describe, it, expect } from 'vitest';

describe('MyCustomAgent', () => {
  it('should process messages correctly', async () => {
    const handler = {
      processMessage: async ({ message }) => ({
        content: `Processed: ${message}`,
      }),
    };
    
    const result = await handler.processMessage({
      conversationId: 'test-123',
      message: 'Hello',
    });
    
    expect(result.content).toBe('Processed: Hello');
  });
});
```

## Next Steps

- [Custom Storage](/guide/custom-storage)
- [Error Handling](/guide/error-handling)
- [API Reference](/api/server)
