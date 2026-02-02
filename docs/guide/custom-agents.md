# Custom Agents

Create custom agents without using the Agent SDK.

## Overview

While `@cognipeer/agent-sdk` provides a powerful agent framework, you can also integrate any AI backend using the custom agent interface.

## Agent Handler Interface

```typescript
interface AgentHandler {
  processMessage(params: ProcessMessageParams): Promise<ProcessMessageResult>;
}

interface ProcessMessageParams {
  conversationId: string;
  message: string;
  files?: FileAttachment[];
  state?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
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
  };
}
```

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

```typescript
agentServer.registerCustomAgent('document-analyzer', {
  processMessage: async ({ message, files }) => {
    if (!files || files.length === 0) {
      return { content: 'Please upload a document to analyze.' };
    }
    
    const results = [];
    
    for (const file of files) {
      // Get file content from storage
      const content = await storage.getFileContent(file.id);
      
      if (file.mimeType === 'application/pdf') {
        const text = await extractPDFText(content);
        results.push(`PDF "${file.name}": ${text.slice(0, 500)}...`);
      } else if (file.mimeType.startsWith('image/')) {
        // Use vision API
        const description = await analyzeImage(content);
        results.push(`Image "${file.name}": ${description}`);
      }
    }
    
    return {
      content: `Analysis complete:\n\n${results.join('\n\n')}`,
    };
  },
});
```

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

## Streaming Custom Agents

For streaming responses, use an async generator:

```typescript
agentServer.registerCustomAgent('streaming-agent', {
  processMessage: async function* ({ message }) {
    // Stream text chunks
    const chunks = ['Hello', ' there!', ' How', ' can', ' I', ' help?'];
    
    for (const chunk of chunks) {
      yield { type: 'text', text: chunk };
      await delay(100); // Simulate processing
    }
  },
});
```

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
