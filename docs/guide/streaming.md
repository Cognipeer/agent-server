# Streaming

Real-time response streaming with Server-Sent Events (SSE).

## Overview

The agent server supports streaming responses, allowing clients to receive partial responses as they're generated. This is especially useful for:

- **Better UX** - Users see responses as they're generated
- **Long responses** - Don't wait for the entire response
- **Tool calls** - See tool execution in real-time

## Enabling Streaming

### Client Request

Enable streaming in your message request:

```typescript
const response = await fetch('/api/agents/conversations/conv-123/messages', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer your-token',
  },
  body: JSON.stringify({
    message: 'Hello!',
    streaming: true,  // Enable streaming
  }),
});
```

### Response Format

Streaming responses use Server-Sent Events (SSE):

```
event: stream.start
data: {"conversationId":"conv-123","messageId":"msg-456","timestamp":1234567890}

event: stream.text
data: {"text":"Hello","timestamp":1234567891}

event: stream.text
data: {"text":" there!","timestamp":1234567892}

event: stream.text
data: {"text":" How can I help?","isFinal":true,"timestamp":1234567893}

event: stream.done
data: {"message":{"id":"msg-456","role":"assistant","content":"Hello there! How can I help?"},"timestamp":1234567894}
```

## Event Types

### stream.start

Sent when streaming begins:

```typescript
interface StreamStartEvent {
  type: 'stream.start';
  conversationId: string;
  messageId: string;
  timestamp: number;
}
```

### stream.text

Sent for each text chunk:

```typescript
interface StreamTextEvent {
  type: 'stream.text';
  text: string;
  isFinal?: boolean;  // True for the last text chunk
  timestamp: number;
}
```

### stream.tool_call

Sent when a tool is called:

```typescript
interface StreamToolCallEvent {
  type: 'stream.tool_call';
  id: string;
  name: string;
  arguments: string;  // JSON string
  timestamp: number;
}
```

### stream.tool_result

Sent when a tool returns:

```typescript
interface StreamToolResultEvent {
  type: 'stream.tool_result';
  id: string;
  name: string;
  result: unknown;
  timestamp: number;
}
```

### stream.progress

Optional progress updates:

```typescript
interface StreamProgressEvent {
  type: 'stream.progress';
  stage: string;
  message?: string;
  percent?: number;
  timestamp: number;
}
```

### stream.error

Sent on errors:

```typescript
interface StreamErrorEvent {
  type: 'stream.error';
  error: string;
  code?: string;
  timestamp: number;
}
```

### stream.done

Sent when streaming completes:

```typescript
interface StreamDoneEvent {
  type: 'stream.done';
  message: Message;  // Final message object
  timestamp: number;
}
```

## Client Implementation

### Using fetch

```typescript
async function streamMessage(conversationId: string, message: string) {
  const response = await fetch(`/api/agents/conversations/${conversationId}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer your-token',
    },
    body: JSON.stringify({
      message,
      streaming: true,
    }),
  });

  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    
    // Parse SSE events
    const lines = buffer.split('\n');
    buffer = lines.pop() || ''; // Keep incomplete line in buffer

    let eventType = '';
    for (const line of lines) {
      if (line.startsWith('event: ')) {
        eventType = line.slice(7);
      } else if (line.startsWith('data: ')) {
        const data = JSON.parse(line.slice(6));
        handleEvent(eventType, data);
      }
    }
  }
}

function handleEvent(type: string, data: unknown) {
  switch (type) {
    case 'stream.start':
      console.log('Started:', data);
      break;
    case 'stream.text':
      console.log('Text:', (data as any).text);
      break;
    case 'stream.tool_call':
      console.log('Tool called:', (data as any).name);
      break;
    case 'stream.done':
      console.log('Done:', (data as any).message);
      break;
    case 'stream.error':
      console.error('Error:', (data as any).error);
      break;
  }
}
```

### Using EventSource

For browsers that support it:

```typescript
// Note: EventSource only supports GET, so we need a wrapper
// or use POST with fetch as shown above
```

### Using @cognipeer/chat-ui

The chat-ui library handles streaming automatically:

```tsx
import { Chat } from '@cognipeer/chat-ui';

<Chat
  baseUrl="/api/agents"
  agentId="assistant"
  streaming={true}  // Default is true
  onStreamText={(chunk, fullText) => {
    console.log('Chunk:', chunk);
    console.log('Full text so far:', fullText);
  }}
  onToolCall={(name, args) => {
    console.log('Tool called:', name, args);
  }}
  onToolResult={(name, result) => {
    console.log('Tool result:', name, result);
  }}
/>
```

## Server Implementation

### SDK Agents

SDK agents stream automatically when registered:

```typescript
const assistant = createSmartAgent({
  name: 'Assistant',
  model: fromLangchainModel(new ChatOpenAI({ streaming: true })),
  tools: [...],
});

agentServer.registerSDKAgent('assistant', assistant);
```

### Custom Agents

Custom agents can implement streaming:

```typescript
agentServer.registerCustomAgent('streaming-agent', {
  processMessage: async function* (params) {
    // Yield text chunks
    yield { type: 'text', text: 'Hello' };
    yield { type: 'text', text: ' there!' };
    
    // Yield tool calls
    yield {
      type: 'tool_call',
      id: 'tool-1',
      name: 'get_weather',
      arguments: JSON.stringify({ location: 'NYC' }),
    };
    
    // Yield tool results
    yield {
      type: 'tool_result',
      id: 'tool-1',
      name: 'get_weather',
      result: { temp: 72, conditions: 'Sunny' },
    };
    
    // Final text
    yield { type: 'text', text: ' The weather is nice!' };
  },
});
```

## Abort/Cancel

### Client-side Abort

```typescript
const controller = new AbortController();

const response = await fetch('/api/agents/conversations/conv-123/messages', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ message: 'Hello', streaming: true }),
  signal: controller.signal,
});

// Cancel the stream
controller.abort();
```

### Using chat-ui

```tsx
const { stop } = useChat({
  baseUrl: '/api/agents',
  agentId: 'assistant',
});

// Stop button
<button onClick={stop}>Stop</button>
```

## Error Handling

```typescript
try {
  const response = await fetch(/* ... */);
  
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  
  const reader = response.body!.getReader();
  // ...
} catch (error) {
  if (error.name === 'AbortError') {
    console.log('Stream was cancelled');
  } else {
    console.error('Stream error:', error);
  }
}
```

## Connection Keep-Alive

For long streams, ensure proper keep-alive:

```typescript
// Server-side: Send heartbeat events
async *streamResponse() {
  const heartbeatInterval = setInterval(() => {
    yield { type: 'heartbeat' };
  }, 15000);
  
  try {
    // ... stream logic
  } finally {
    clearInterval(heartbeatInterval);
  }
}
```

## Next Steps

- [Swagger UI](/guide/swagger)
- [Custom Agents](/guide/custom-agents)
- [Error Handling](/guide/error-handling)
