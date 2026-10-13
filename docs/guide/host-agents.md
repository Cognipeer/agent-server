# Host-backed agents

An agent-sdk agent runs inside the server process. Often the agent is somewhere else: your product's own runtime behind an HTTP API, a workflow engine, a queue. A **host-backed agent**
lets the server serve it like any other agent - streaming, approvals, cancel, reattach, files, budgets - while the work stays in your backend.

You describe the agent with two or three functions. While a turn runs, the agent tells the server what is happening with typed events; when it ends, it returns a typed result.
The server stores the messages, the pending actions, the events and the runtime status itself. Nothing in the agent has to pretend to be an agent-sdk object, and nothing writes
into the server's own state.

```typescript
server.registerHostAgent({
  info: { id: 'support', name: 'Support', capabilities: { toolApproval: true } },

  async invoke({ message, history, files, context }, { emit, signal }) {
    const run = await backend.start({ message, user: context.user?.id }, { signal });
    for await (const event of run.events()) {
      if (event.kind === 'text') emit({ type: 'text', text: event.text });
      if (event.kind === 'tool') emit({ type: 'tool_use', id: event.id, name: event.name, args: event.args });
      if (event.kind === 'tool-done') emit({ type: 'tool_result', id: event.id, result: event.result });
    }
    const result = await run.result();
    return result.needsApproval
      ? { pendingActions: [{ id: result.requestId, type: 'tool_approval', toolName: result.tool, args: result.args }] }
      : { content: result.text, usage: result.usage };
  },

  // Optional: only an agent that can pause needs it
  async resolveAction({ actionId, resolution }, { emit, signal }) {
    const result = await backend.answer(actionId, resolution, { signal });
    return { content: result.text };
  },

  // Optional: your backend runs elsewhere and has to be told to stop
  async cancel({ runId, reason, actions }) {
    await backend.cancel({ runId, actions });
  },
});
```

Versus `registerCustomAgent`: a handler returns once, so a streamed request gets the whole answer at the end; a host agent streams, reports tool calls, is cancelled through a signal and
a hook, and is handed the full answer to an approval.

## invoke

`invoke(input, io)` runs one user message.

| `input` | |
| --- | --- |
| `conversationId`, `runId` | The conversation, and the run this turn executes as (the `runId` of the response and of the stored events) |
| `message` | What the person typed. The files are not in it |
| `mode`, `fromMessageId` | Set when the turn is a [regeneration or an edit-and-resend](./chat-experience.md#message-actions): `mode` is `"regenerate"` (the newest answer is asked for again; `message` is the user message it answered, `fromMessageId` the answer being replaced) or `"edit"` (a message was changed; `message` is the new text, `fromMessageId` the user message it replaces). Absent for a new message. A backend that keeps its own transcript **rewinds it to that message and runs `message` again** |
| `history` | The conversation so far, oldest first, including this message (`Message[]`) - already cut back for a regenerate or an edit. A backend that keeps its own transcript ignores it |
| `files` | The files this message carries - stored, so every entry has a real id |
| `metadata` | What the request put in `metadata` (a [task](../tasks.md) hands over its comments) |
| `context` | The request context from `resolveContext`: the user and your own data (tenant, portal, ...) |

| `io` | |
| --- | --- |
| `emit(event)` | Reports progress, see below |
| `signal` | Aborted when the run is cancelled |
| `files` | `list()`, `read(fileId)`, `text(fileId)`: the conversation's files, and only those (anything else answers `null`) |

### Events

| `emit({ type, ... })` | What the server does |
| --- | --- |
| `text` `{ text }` | A chunk of the answer: a `stream.text` frame for the connection that sent the message, and a live `agent.message.delta` for [followers](./runs.md) |
| `thinking` `{ text }` | A chunk of the model's reasoning: a live `stream.thinking` frame (not stored, not part of the answer). Dropped when `AgentInfo.showReasoning` is `false` |
| `tool_use` `{ id, name, args? }` | An `agent.tool_use` event and a `stream.tool_call` frame |
| `tool_result` `{ id, name?, result?, error? }` | An `agent.tool_result` event (`ok: false` with `error`) and a `stream.tool_result` frame. Pair it with its `tool_use` by `id` |
| `action_required` `{ actions }` | The turn waits on these. Same as returning them as `pendingActions`; stored first, announced when the turn ends. An approval can carry `argsSchema` (JSON Schema of the tool's arguments; `toJsonSchema(zodSchema)` converts a zod schema): clients validate edits against it and the server checks `approvedArgs` against it |
| `usage` `{ usage }` | What one model call used. Added up over the turn |
| `stop` `{ stopReason, detail? }` | Why the turn stopped, when you know before you return |

A malformed event (an unknown type, a `tool_use` without an id) is ignored, with one warning in the log per turn. Events after the turn has ended are dropped.

### The result

`invoke` (and `resolveAction`) return the facts of the turn:

| Field | |
| --- | --- |
| `content` | The answer. Leave it out when `text` events carried it: what was streamed is the answer. A turn that only pauses has none |
| `pendingActions` | What the turn waits on, now. It **replaces** the pause: `[]` says nothing is open any more. Omitted: the actions you emitted, if any |
| `status` | `requires_action` is implied by `pendingActions`; `incomplete` / `cancelled` say the turn did not finish |
| `stopReason` | `end_turn` (default), `requires_action` (implied), `cancelled`, `max_turns`, `limit`, `budget_reached`, `error`. The result wins over an emitted `stop` |
| `usage` | `{ inputTokens, outputTokens, totalTokens, cachedInputTokens, costUsd, model }`. Replaces the emitted `usage` events |
| `files` | Files the answer produced (`{ id, name, mimeType, size }`, already stored with `POST /files`) |
| `metadata`, `detail` | Reported with the turn; `detail` is the `detail` of `session.status_idle` |

A result the server cannot use - not an object, a `status` it does not know, a pending action without an id, two actions with one id, an `expiresAt` that is no date - is a `500
invalid_host_result` (masked with `maskServerErrors`); the turn is closed as `error` and the conversation is usable again. Nothing half-made is stored.

## Approvals and questions

Return `pendingActions` (or emit `action_required`) and the turn pauses:

```typescript
return {
  content: 'I need your OK first.',
  pendingActions: [
    { id: 'req_17', type: 'tool_approval', toolName: 'wire_money', title: 'Wire $5?', args: { amount: 5 }, expiresAt: '2026-10-12T10:00:00.000Z' },
    { id: 'req_18', type: 'user_question', questions: [{ question: 'Which account?', options: [{ label: 'main' }, { label: 'savings' }] }] },
  ],
};
```

The server stores the pause with the message, announces it (`action.required` events, `stream.action_required`), shows `runtime.status: "requires_action"`, applies the timeouts
(`expiresAt`, else `hitl.timeoutMinutes`) and checks who may answer (`hitl.authorizeResolve`). See [Approvals & Questions](./human-in-the-loop.md).

When somebody answers, **`resolveAction` is called once per answered action**:

| `input` | |
| --- | --- |
| `actionId`, `action` | The action, as it was asked |
| `resolution` | The whole answer: `decision`, `comment`, `approvedArgs`, `rememberForSession`, or a question's `answers` |
| `pendingActions` | The other actions of the pause that are still open |
| `actor`, `channel`, `expired` | Who answered (the user id, or `system:timeout`), where from (`api` or `timeout`), and whether the request lapsed and `hitl.onTimeout: "deny"` answered it as a refusal |
| `conversationId`, `runId`, `metadata`, `context` | As for `invoke` |

What it returns replaces the pause:

- **Still waiting on the rest.** Return `input.pendingActions` as they are and nothing else (no `content`, `usage` or files): the answer is only recorded on the message that asked - it shows `resolved`, the others stay `pending` there -
  and there is no new message. Answer the last one and the agent's reply is the message of the turn.
- **Done, or moving on.** Return a `content` (and `pendingActions` for whatever it asks next, or none). The reply is a new assistant message; the answered action is recorded as `resolved` on the message that asked it.
  An open request the reply does not carry on - left out, or asked again changed - is withdrawn from the old message (`cancelled`, by `system`, with an `action.resolved` event); a changed one is asked on the reply.

Without `resolveAction` the agent cannot pause: answering its actions is a `404`. What the server **does not** do for a host agent, because your backend owns the decision:

- `rememberForSession` arrives in the resolution; remembering the tool, and not asking again, is yours (`GET .../remembered-tools` lists what the server remembers for SDK agents).
- `approvedArgs` are passed as they are; the server cannot check them against a schema it does not have.
- `POST /conversations/:id/continue` carries on an agent-sdk turn the budget stopped. A host agent reports `stopReason: "budget_reached"` and decides what the next message does.

### Client tools

A request of `type: 'client_tool'` is for the page that embeds the chat, not for a person - return it in `pendingActions` like an approval and handle the page's result (`resolution: { type: 'client_tool', output }`, or `{ type: 'client_tool', error }` when the page failed or never answered) in `resolveAction`.
See [Client tools](./human-in-the-loop.md#client-tools).

## Feedback

A person can rate an answer (`POST /conversations/:id/messages/:messageId/feedback`, see [Chat experience](./chat-experience.md#feedback)). The server stores the rating on the message; implement **`feedback(event)`** to keep your own record - an analytics table, an evaluation set:

```typescript
server.registerHostAgent({
  info: { id: 'support', name: 'Support' },
  async invoke(input, io) { /* ... */ return { content: '...' }; },
  async feedback(event) {
    // event: { conversationId, messageId, messageIndex, agentId, userId, rating: 'up' | 'down' | null (withdrawn), reasons, comment?,
    //          previous?, message (the answer), question? (what it answered), createdAt, updatedAt, context }
    await db.insert('answer_feedback', { ... });
  },
});
```

It runs after the rating is stored and before the server-wide `feedback.onFeedback`. A failure fails the request with its error - the rating stays, and sending the same request again is safe (a rating is replaced, never added).

## Cancel

`POST /conversations/:id/cancel` (and a deleted conversation, and `server.close({ abort: true })`) aborts `io.signal`. Pass it to whatever your agent awaits; return what you have. Text already emitted
is kept as the cancelled message. An agent that ignores the signal is abandoned `runs.cancelGraceMs` later (default 5 s): the conversation is free again and anything it reports afterwards is dropped.

`cancel(input)` tells a backend that runs elsewhere:

| `reason` | When |
| --- | --- |
| `user` | `POST /conversations/:id/cancel` while `invoke` or `resolveAction` was working. `runId` is the run |
| `remote` | The same, asked through another node |
| `lease_lost` | Another node took the conversation over |
| `deleted` | The conversation is deleted (while it ran, or while it waited: `actions` are the open requests) |
| `shutdown` | `server.close({ abort: true })` |
| `withdrawn` | Open requests were withdrawn: the cancel route on a paused conversation, or a new message under `pendingActionPolicy: 'cancel'` (`actions`, no `runId`) |
| `expired` | Open requests lapsed under `hitl.onTimeout: "cancel"` (`actions`, no `runId`) |

A hook that throws is logged and never fails the request, and one that does not answer within `runs.cancelGraceMs` is given up on: the conversation is not held for it.

## Files

`io.files` reads the conversation's files: `list()` (oldest first), `read(fileId)` (bytes) and `text(fileId)` (extracted text, the way the server gives it to an agent, see
[Files](./file-management.md)). A file of another conversation, or one that expired, is `null`. The server does not paste the files into the message for a host agent; it hands them over.

## Usage and budgets

Report what the turn used - `usage` events and / or `usage` in the result. Put `costUsd` on it, or `model` so the server prices the tokens with `pricing`, and the turn counts toward the
conversation's `spentUsd` and its budget (`budget_reached` after the turn that crosses it; the next message is `402`). A host agent cannot be stopped in the middle by the server's budget:
there is nothing to hand the cap to. See [Usage & Budgets](./budgets.md).

## Per-request agents

An agent that depends on the request (a tenant's own agents) is part of `config.agents`; build its registration with `hostAgentRegistration`:

```typescript
import { createAgentServer, hostAgentRegistration } from '@cognipeer/agent-server';

createAgentServer({
  basePath: '/api',
  storage,
  resolveContext,
  agents: (ctx) => tenantAgents(ctx.data.tenant).map((agent) => hostAgentRegistration({ info: agent.info, ...behaviourOf(agent) })),
});
```

A per-request registry is also asked for work that belongs to no request: the timeout sweep of lapsed approvals looks the agent up with `{ user: <owner>, data: { system: true, timeout: true } }`
(recovery and pruning reach only the storage provider, with `{ data: { system: true } }`). Return the agent for that context too - for example by keeping the tenant on the conversation's `metadata` and reading
it from there - or a `deny` pause that lapses is cancelled instead of denied, and the host agent is not told (the server logs a warning). See [Approvals & Questions](./human-in-the-loop.md#requests-that-lapse).

A per-request agent that accepts bigger files than the server's default needs `limits.maxBodySize` (or the Fastify `uploadBodyLimit`) set above its largest file: the default body limit is derived from
the agents registered at startup only, see [Files](./file-management.md#adapters).

A definition that cannot work (no `info.id`, no `invoke`) throws when it is registered, not at the first message. `files`, `hitl`, `budget` and `pricing` in the definition are the per-agent
settings of every other agent.

## Moving from an agent-sdk look-alike

If your agent pretends to be an agent-sdk agent so that it can stream and pause - it fabricates the paused state, writes into the server's `__agentServerHitl` state key, fakes
`resolveToolApproval`, and smuggles the real answer through the request context - replace all of it:

| Before | After |
| --- | --- |
| `onStream({ text })` / `onEvent({ type: 'tool_call', phase })` | `emit({ type: 'text' })` / `emit({ type: 'tool_use' })` + `emit({ type: 'tool_result' })` |
| a fabricated `pendingApprovals` state, `__agentServerHitl` | `pendingActions` in the result |
| `resolveToolApproval` / `resolveUserQuestion` stubs, the answer kept in the context | `resolveAction`, which is handed the whole answer |
| the turn's `stopReason` dropped on the way out | `stopReason` and `usage` in the result |
| a cancel that stops the HTTP request only | `io.signal`, and `cancel` for the backend |

`registerSDKAgent`, `registerCustomAgent` and the other registrations are unchanged.
