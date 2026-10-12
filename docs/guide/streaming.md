# Streaming

Real-time responses with Server-Sent Events (SSE).

A streamed request is a *subscriber* of the run that executes the turn, not the run itself: if the client disconnects the turn
**keeps running** and is stored when it finishes. Reconnect with the event cursor to pick it up - see [Runs, Cancel & Reattach](./runs.md).

## Enabling streaming

Send `stream: true` with the message (or with the answer to an [approval](./human-in-the-loop.md)):

```typescript
const response = await fetch('/api/agents/conversations/conv_123/messages', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: 'Bearer your-token' },
  body: JSON.stringify({ message: 'Hello!', stream: true }),
});
```

The response is `text/event-stream`. Every event is a single `data:` line holding JSON with a `type`, followed by a blank line:

```
data: {"type":"stream.start","conversationId":"conv_123","messageId":"msg_1","timestamp":1234567890,"seq":2}

data: {"type":"stream.text","text":"Hello","isFinal":false,"timestamp":1234567891,"seq":2}

data: {"type":"stream.text","text":" there!","isFinal":false,"timestamp":1234567892,"seq":2}

data: {"type":"stream.done","conversationId":"conv_123","messageId":"msg_2","content":"Hello there!","stopReason":"end_turn","runId":"run_x1","timestamp":1234567894,"seq":5}
```

`POST /conversations/:id/messages/:messageId/regenerate` and `.../edit` answer with `stream: true` in the same way (`stream.start` carries the id of the user message that is answered, or of the new user message of an edit).
A request that cannot start is an HTTP status, not a stream: `404` for an unknown `fileIds`, `409 action_pending` while an
action is pending, `409 conversation_busy` while the conversation is running another turn. (A streamed request for a
conversation or agent that does not exist, or is not yours, answers `200` with a stream that carries one `stream.error`.)

## The cursor: `seq`

Every `stream.*` frame carries `seq`: the position in the conversation's [event log](./runs.md#the-event-log) at that frame - the `seq` of the stored
event the frame reports, or of the newest one before it for frames that are not stored (text chunks). Remember the last one. If the connection drops:

```http
GET /api/agents/conversations/conv_123/events/stream?after=<last seq>
```

replays what you missed from the log and follows the turn from there. (`GET .../events?after=` is the same without the live part.)
You lose at most the text chunks in between - the finished `agent.message` event has the whole text.

## Event types

### stream.start

```typescript
interface StreamStartEvent {
  type: 'stream.start';
  conversationId: string;
  messageId: string;      // the user message (for a resolved action: the paused assistant message)
  timestamp: number;
  seq?: number;
}
```

### stream.text

A chunk of the answer. The last one of an agent that did not stream is the whole answer with `isFinal: true`.

```typescript
interface StreamTextEvent {
  type: 'stream.text';
  text: string;
  isFinal?: boolean;
  timestamp: number;
  seq?: number;
}
```

### stream.tool_call / stream.tool_result

```typescript
interface StreamToolCallEvent {
  type: 'stream.tool_call';
  toolName: string;
  toolCallId: string;
  args: Record<string, unknown>;
}

interface StreamToolResultEvent {
  type: 'stream.tool_result';
  toolName: string;
  toolCallId: string;
  result: unknown;        // { error: string } when the tool failed
}
```

### stream.progress

Sent by custom handlers (`stage: "processing"`) before they answer; they do not stream text.

### stream.error

```typescript
interface StreamErrorEvent {
  type: 'stream.error';
  error: string;
  code?: string;          // the error's own code for errors the host raised (e.g. NOT_FOUND), else INTERNAL_ERROR
}
```

With `maskServerErrors: true` only errors the host marked for the client keep their message.

### stream.action_required / stream.action_resolved

When the agent pauses for a tool approval, a question or a [client tool](./human-in-the-loop.md#client-tools) (`type: "client_tool"`: a client shows no card, it hands the call to the host page), `stream.action_required` (with the `actions`) precedes the final `stream.done`,
which carries `status: "requires_action"`. `stream.action_resolved` is the first event after `stream.start` of the stream returned
by `POST /conversations/:id/actions/:actionId` (with `resolution.expired: true` when it is the sweep answering a lapsed request, which has no stream to speak of). The stream of `POST /conversations/:id/continue` starts with
`stream.start` and ends with `stream.done` the same way. See [Approvals & Questions](./human-in-the-loop.md) and [Usage & Budgets](./budgets.md).

### stream.done

```typescript
interface StreamDoneEvent {
  type: 'stream.done';
  conversationId: string;
  messageId: string;                 // the assistant message
  content: string;
  title?: string;                    // generated on the first exchange
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number; cachedInputTokens?: number; costUsd?: number };   // this turn only
  budget?: { maxCostUsd: number; onReach: 'pause' | 'stop' };   // when the conversation has a budget ...
  spentUsd?: number;                                            // ... and what it has spent, this turn included
  status?: 'requires_action' | 'incomplete' | 'cancelled';   // only when the turn did not simply complete
  pendingActions?: PendingAction[];
  warnings?: TurnWarning[];
  stopReason?: 'end_turn' | 'requires_action' | 'cancelled' | 'max_turns' | 'limit' | 'budget_reached' | 'error';
  runId?: string;
  seq?: number;
}
```

A turn that is [cancelled](./runs.md#cancel) ends with `stream.done` and `status: "cancelled"`, carrying the text streamed so far. A turn that fails ends with `stream.error`
(nothing is stored for the assistant). Clients ignore event types they do not know.

## Client implementation

### Using fetch

```typescript
async function streamMessage(conversationId: string, message: string, onEvent: (e: any) => void) {
  const response = await fetch(`/api/agents/conversations/${conversationId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer your-token' },
    body: JSON.stringify({ message, stream: true }),
  });
  if (!response.ok) throw await response.json();      // 409 conversation_busy, 404, ...

  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let lastSeq = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split('\n\n');
    buffer = frames.pop() ?? '';
    for (const frame of frames) {
      if (!frame.startsWith('data: ')) continue;
      const event = JSON.parse(frame.slice(6));
      if (event.seq) lastSeq = event.seq;
      onEvent(event);
    }
  }
  return lastSeq;
}
```

### Following with EventSource

The *event stream* is a `GET`, so a browser's `EventSource` can follow it and reconnects by itself with `Last-Event-ID`:

```typescript
const source = new EventSource(`/api/agents/conversations/${id}/events/stream?after=${lastSeq}`);
source.addEventListener('agent.message', (e) => console.log(JSON.parse((e as MessageEvent).data).data.content));
source.addEventListener('agent.message.delta', (e) => append(JSON.parse((e as MessageEvent).data).text));
source.addEventListener('session.status_idle', () => reloadConversation());
```

(`EventSource` cannot send an `Authorization` header; use a cookie session through `resolveContext`, or follow with `fetch`.)

### Using @cognipeer/chat-ui

```tsx
import { Chat } from '@cognipeer/chat-ui';

<Chat baseUrl="/api/agents" agentId="assistant" />
```

## Server implementation

### SDK agents

SDK agents stream when registered; tool calls and results are reported even for a non-streamed request (they go to the event log).

```typescript
const assistant = createSmartAgent({ name: 'Assistant', model, tools: [/* ... */] });
agentServer.registerSDKAgent('assistant', assistant);
```

### Custom handlers

A custom handler answers in one piece: the stream carries `stream.progress`, then the whole answer as one `stream.text` with `isFinal: true`.
Honour `signal` so that [cancel](./runs.md#cancel) can stop it.

## Disconnecting and stopping

Closing the connection (`AbortController.abort()`, closing the tab) **does not stop the turn**; the answer and any pending approval are
stored and the conversation is busy until the turn is done (`409 conversation_busy`). To stop it:

```typescript
await fetch(`/api/agents/conversations/${id}/cancel`, { method: 'POST' });
```

The stream that was following the turn then ends with `stream.done` (`status: "cancelled"`). A "Stop" button should call this and abort its own fetch.

## Keep-alive

`GET .../events/stream` sends a `: ping` comment every 15 seconds (`runs.pingIntervalMs`). A message stream is as long as its turn;
if a proxy in front of you times out long silences, follow the turn through the event stream, which pings.

## Next Steps

- [Runs, Cancel & Reattach](./runs.md)
- [Approvals & Questions](./human-in-the-loop.md)
- [Error Handling](./error-handling.md)
