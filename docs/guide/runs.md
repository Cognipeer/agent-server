# Runs, Cancel & Reattach

A turn - a message, or the answer to an approval - runs as a **run**, independent of the HTTP request that started it.
Closing the tab, losing the connection or a proxy timeout does **not** stop it: the agent finishes, the answer and any
pending approval are stored, and a client that comes back picks up where it left off. To stop a turn, say so:
`POST /conversations/:id/cancel`.

What a run gives you:

| | |
| --- | --- |
| **Detached** | A streamed request is a *subscriber* of its run. Disconnecting unsubscribes; the run goes on. |
| **Cancellable** | `POST /conversations/:id/cancel` aborts the run: agent-sdk agents see it as their `cancellationToken`, custom handlers as `signal`. |
| **One at a time** | A conversation runs one turn at a time, across all server instances sharing the storage: a second one is `409 conversation_busy`. |
| **Logged** | Everything that happens is appended to the conversation's event log, readable and followable (`GET .../events`, `.../events/stream`). |
| **Observable** | `conversation.runtime` says whether a conversation is running, waiting for a human, or idle, and why the last turn stopped. |
| **Recoverable** | A run whose server died is closed as interrupted; a task left `running` is failed. |

## Runtime

`GET /conversations/:id` and every item of `GET /conversations` carry `conversation.runtime`:

```json
{
  "status": "requires_action",
  "stopReason": "requires_action",
  "lastEventSeq": 41,
  "pendingActionIds": ["ap_9"],
  "activeRunId": "run_x1"
}
```

| Field | |
| --- | --- |
| `status` | `idle`, `running` (a turn is executing, here or on another node), `requires_action` (waiting for a [human](./human-in-the-loop.md)), `budget_paused` (the last turn stopped on the conversation's [budget](./budgets.md) and it is still used up) |
| `stopReason` | Why the last turn stopped: `end_turn`, `requires_action`, `cancelled`, `max_turns`, `limit`, `budget_reached`, `error`. Absent while a turn is running. |
| `lastEventSeq` | `seq` of the newest event (0 when there is none): follow from here with `?after=` |
| `pendingActionIds` | The actions the conversation waits on |
| `activeRunId` | The running run (the `runId` of the message response, the `run_id` of its events) |

The assistant message of every turn records how it ended: `message.status` (`completed`, `requires_action`, `incomplete`, `cancelled`) and
`message.metadata.stopReason`. A custom handler can report `max_turns` or `limit` itself with `stopReason` in its result; `budget_reached` is the server's, when the conversation's [budget](./budgets.md) ends a turn.

## One turn at a time

```http
POST /api/conversations/conv_1/messages        -> 200   (a turn starts)
POST /api/conversations/conv_1/messages        -> 409   { "error": { "code": "conversation_busy", "details": { "activeRunId": "run_x1" } } }
POST /api/conversations/conv_1/actions/ap_9    -> 409   conversation_busy
```

This is the answer to a double click, two tabs, or two servers: it is a real HTTP status even for a streamed request, and nothing is stored for
the refused one. The first turn is not affected. With a storage provider that supports **leases** (all built-in ones) the rule holds across
server instances; a lease is renewed while the run is alive, so a crashed server frees its conversations after `runs.leaseTtlMs` (60 s).

## Cancel

```http
POST /api/conversations/conv_1/cancel
```

```json
{
  "cancelled": true,
  "runId": "run_x1",
  "settled": true,
  "stopReason": "cancelled",
  "runtime": { "status": "idle", "stopReason": "cancelled", "lastEventSeq": 14, "pendingActionIds": [] }
}
```

- **A turn is running.** It is aborted. The agent gets the abort signal (a model call is cut, a tool that honours `signal` stops), the answer streamed so far
  is kept as the assistant message with `status: "cancelled"`, and the request that started the turn ends with `status: "cancelled"` /
  `stopReason: "cancelled"` (`stream.done` for a stream). An agent that ignores the signal is abandoned after `runs.cancelGraceMs` (5 s): whatever it does later changes nothing.
  The response is `200` once the run has finished winding down; `202` with `settled: false` when it is still stopping, or runs on another node
  (that node sees the request at its next lease renewal).
- **The conversation waits on a human.** Its open actions are cancelled: an `action.resolved` event with `cancelled: true` for each, then `session.status_idle` with `stop_reason: "cancelled"`. `cancelledActionIds` lists them.
- **Nothing to cancel** is not an error: `cancelled: false`.

Deleting a conversation that is running cancels its run first.

### In an SDK agent or a handler

```typescript
agentServer.registerCustomAgent('slow', {
  async processMessage({ message, signal }) {
    const res = await fetch(url, { signal });      // stops when the run is cancelled
    return { content: await res.text() };
  },
});
```

For agent-sdk agents nothing is needed: the signal is passed as `cancellationToken` (an `AbortSignal` is a valid token, and tools receive it).
An SDK result with `state.ctx.__cancelled` is a cancelled turn; `state.ctx.__limitBreached` ends the turn with `stopReason: "limit"`.

## The event log

Every conversation has an append-only log of what happened in it, in the same vocabulary as Console's session events:
snake_case types and data, `seq` unique and ascending within the conversation.

| Type | `data` |
| --- | --- |
| `user.message` | `content`, `message_id`, `files?` (`id`, `name`, `mime_type`, `size` of each file the message carries) |
| `session.status_running` | `trigger`: `message`, `resume` (an answer, or a [continuation](./budgets.md#raising-it-and-carrying-on)) or `timeout` (a request [lapsed](./human-in-the-loop.md#requests-that-lapse) and the agent carries on) |
| `agent.tool_use` | `tool_call_id`, `name`, `args` |
| `agent.tool_result` | `tool_call_id`, `name`, `ok`, `duration_ms?`, `error?` |
| `agent.message` | `content`, `message_id`, `stop_reason`, `usage?` (`input_tokens`, `output_tokens`, `total_tokens`, `cached_input_tokens?`, `cost_usd?`) |
| `session.usage` | `input_tokens`, `output_tokens`, `total_tokens`, `cached_input_tokens?` and - with [pricing](./budgets.md#prices) - `turn_cost_usd`, `spent_usd`, `budget?` (`max_cost_usd`, `on_reach`) |
| `budget.reached` | `spent_usd`, `max_cost_usd`, `on_reach`; just before the `session.status_idle` with `stop_reason: budget_reached` |
| `action.required` | `action_id`, `kind` (`tool_approval` \| `user_question`), `tool_name?`, `summary?`, `args?`, `questions?`, `allow_free_text?`, `expires_at?` |
| `action.resolved` | `action_id`, `kind`, `decision?`, `cancelled?`, `expired?`, `remembered?`, `edited_args?`, `status` (`approved`, `rejected`, `answered`, `cancelled`, `expired`), `resolved_by`, `channel` (`api`, `system`, `timeout` or `remembered`) |
| `session.status_idle` | `stop_reason`, `pending_action_ids?`, `detail?` |
| `session.work_done` | none; right after an idle with `stop_reason: end_turn` |
| `session.error` | `message`, `code?` |

A turn is bracketed by `session.status_running` and `session.status_idle`. A new type can appear in a future version: ignore the ones you do not know.
Event `data` over 16 KB (`runs.maxEventDataBytes`) is cut and carries `_truncated: true`; the stored message is always whole.

```http
GET /api/conversations/conv_1/events?after=40&types=agent.message,session.status_idle&limit=100
```

```json
{
  "events": [
    { "seq": 41, "type": "agent.tool_use", "data": { "tool_call_id": "c1", "name": "search", "args": { "q": "cats" } }, "run_id": "run_x1", "created_at": "2026-10-11T10:00:03.120Z" }
  ],
  "hasMore": false,
  "lastSeq": 41
}
```

Oldest first. Pass `lastSeq` as `after` for the next page. `limit` is 100 by default and at most 1000.

### Following a conversation

```http
GET /api/conversations/conv_1/events/stream?after=41
Accept: text/event-stream
```

Server-Sent Events. The stream **replays** the stored events after `after` (or after the `Last-Event-ID` header a browser `EventSource` sends when it
reconnects - the header wins), then **follows** the conversation live. It subscribes before it reads, so an event that is stored while the replay
runs is neither missed nor sent twice. Each stored event is a frame:

```
id: 42
event: agent.tool_use
data: {"seq":42,"type":"agent.tool_use","data":{"tool_call_id":"c2","name":"web_search","args":{"q":"..."}},"run_id":"run_x1","created_at":"..."}
```

`data` is the same object as an item of the event list. Besides the stored events there are `agent.message.delta` frames (`data: {"text":"..."}`),
the model's text as it is written. They have no `id` and are not stored. They exist for a turn that was started with `stream: true`; a turn started
without it shows the finished `agent.message` at once. Treat deltas as a bonus: build a follower around the stored events.

`: ping` is sent every 15 s (`runs.pingIntervalMs`); the first line is `: open`. The stream stays open across turns until the client closes it or
`runs.maxStreamMs` (one hour) passes - reconnect with the last `id`. With `types=` only those types (and, if listed, `agent.message.delta`) are sent.

A client that goes away only closes its own stream. Events written by another server instance reach the stream by polling the log
(`runs.followPollMs`, 1 s).

### Reattaching after a reload

1. `GET /conversations/:id` - render the history and `pendingActions`; read `runtime`.
2. If `runtime.status === 'running'`: `GET /conversations/:id/events/stream?after=<runtime.lastEventSeq>` and show the live turn (text deltas, tool calls, new cards). When `session.status_idle` arrives, reload the final message.
3. If it is `requires_action`: show the cards and resolve them.

A client that streamed a message and lost the connection uses the `seq` of the last `stream.*` frame it saw the same way - see [Streaming](./streaming.md).

### Providers without an event log

`capabilities().events` is `true` for the built-in providers. A custom provider that has no `events` still works: the server keeps the last
`runs.memoryEventLimit` (2 000) events per conversation **in memory**. Reattach and replay then work while the process lives, on one node,
and the log (and its `seq`) starts over after a restart. See [Custom Storage](./custom-storage.md).

## Recovery

A run that was executing when its server died never wrote `session.status_idle`. When the lease it held has expired:

- the next message to that conversation takes it over and first closes the old run: `session.error` (`code: "run_interrupted"`) and `session.status_idle` with `stop_reason: "error"`;
- the sweep does the same for conversations nobody writes to: once at the first request, then every `runs.sweepIntervalMs` (60 s). Call `server.recoverStaleRuns()` yourself to run it on demand.

The same sweep handles the approvals and questions nobody answered in time ([Requests that lapse](./human-in-the-loop.md#requests-that-lapse)); `server.expirePendingActions()` runs that part on demand.

A [task](/tasks) left `running` by a process that is gone is failed (`"The server stopped while the task was running"`). With leases that means
a task nobody has renewed a lease for in `runs.leaseTtlMs`; without leases the server assumes it is the only node and fails what it finds that is older than itself
(`runs.assumeSingleNode: false` turns that off for a multi-node deployment on a provider without leases).

Events older than `runs.eventRetentionDays` (30) are pruned by the sweep; a conversation's log is deleted with the conversation. The same sweep deletes the
[files](./file-management.md#retention) past their `files.retentionDays` (at most once per `files.purgeIntervalMs`); with `sweepIntervalMs: 0` call `server.purgeExpiredFiles()` yourself.

## Configuration

```typescript
createAgentServer({
  basePath: '/api',
  storage,
  runs: {
    leaseTtlMs: 60_000,        // a crashed server frees its conversations after this long
    cancelGraceMs: 5_000,      // how long a cancelled run may take to wind down before it is abandoned
    cancelWaitMs: 5_000,       // how long POST .../cancel waits before answering 202
    pingIntervalMs: 15_000,    // `: ping` on the event stream
    followPollMs: 1_000,       // how often a follower looks for events written by another node
    maxStreamMs: 3_600_000,    // longest an event stream stays open
    eventPageSize: 100,        // GET .../events default `limit`
    maxEventPageSize: 1_000,
    maxEventDataBytes: 16_384, // larger event data is cut (`_truncated: true`)
    memoryEventLimit: 2_000,   // events kept per conversation when the provider has no event log
    eventRetentionDays: 30,    // 0 keeps them for good
    sweepIntervalMs: 60_000,   // 0: no periodic sweep
    recoverOnStart: true,      // recover once at the first request
    assumeSingleNode: true,    // see Recovery
    nodeId: 'web-1',           // names this instance in leases (default: random)
  },
});
```

`await server.close()` stops the periodic sweep (and, with `{ abort: true }`, cancels the running turns and waits for them).

## Next Steps

- [Streaming](./streaming.md)
- [Approvals & Questions](./human-in-the-loop.md)
- [Storage Providers](./storage.md), [Custom Storage](./custom-storage.md)
