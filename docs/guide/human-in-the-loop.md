# Approvals & Questions

An agent can pause a turn to ask a human before it goes on: approve a tool call, or answer a question. The server persists the paused turn, tells the client what is pending, and continues the turn when the client answers.

Everything here is additive. An agent that never pauses produces the same responses and streams as before.

## The flow

1. The client sends a message (`POST /conversations/:id/messages`, streaming or not).
2. The agent pauses. The turn ends with `status: "requires_action"` and `pendingActions`:
   - streaming: `stream.action_required`, then `stream.done` with `status: "requires_action"`;
   - JSON: the message response carries `status` and `pendingActions`.
3. The client shows the request and answers with `POST /conversations/:id/actions/:actionId`.
4. The server resumes the agent and returns (or streams) the continuation as a **new** assistant message. It can pause again.

A reloaded UI finds the open request in `GET /conversations/:id` (`pendingActions`, omitted when empty).

## Pending actions

```typescript
type PendingAction =
  | { id: string; type: 'tool_approval'; toolName: string; toolCallId?: string;
      title?: string; summary?: string; args?: Record<string, unknown>; expiresAt?: string }
  | { id: string; type: 'user_question'; questions: UserQuestion[];
      allowFreeText?: boolean; expiresAt?: string };
```

- `title` is the tool's `approvalPrompt`; `summary` is a one-line description of what approving does (`metadata.summary` of the agent-sdk entry).
- A question's options can carry a `preview` (agent-sdk's `UserQuestionOption.preview`: a code or ASCII sketch shown while the option is focused).
- `expiresAt` is when the request [lapses](#requests-that-lapse).

A paused assistant message also carries what it asked, in `metadata.pendingActions` - see [The record an answer leaves](#the-record-an-answer-leaves).

## Resolving

```http
POST /conversations/conv_1/actions/ap_9
Content-Type: application/json

{ "resolution": { "type": "tool_approval", "decision": "allow" }, "stream": true }
```

| Action | Resolution |
|--------|-----------|
| `tool_approval` | `{ type, decision: 'allow' \| 'deny', comment?, approvedArgs?, rememberForSession? }` |
| `user_question` | `{ type, answers: { '<question text>': 'value' \| ['v1', 'v2'] }, cancelled? }` |

- `approvedArgs` must be a JSON object; it replaces the tool arguments when allowing, and is [checked against the tool's schema](#edited-arguments-are-checked).
- `rememberForSession` (SDK agents): later pauses on the same tool in this conversation are approved automatically - see [Remembered tools](#remembered-tools).
- Answers are matched to options by value or label; anything else counts as free text (only valid when the question allows it).

Errors:

| Status | Code | Meaning |
|--------|------|---------|
| `400` | `VALIDATION_ERROR` | malformed or invalid resolution (nothing is consumed - answer again) |
| `400` | `invalid_approved_args` | the edited arguments are not arguments the tool accepts |
| `402` | `budget_reached` | the answer would let the agent run again and the conversation's [budget](./budgets.md) is used up (nothing was recorded) |
| `403` | `FORBIDDEN` / `action_forbidden` | not your conversation / [you may not answer this request](#who-may-answer) |
| `404` | `NOT_FOUND` | conversation not found, or the agent cannot resolve actions |
| `409` | `action_not_pending` | unknown or already resolved action |
| `409` | `conversation_busy` | the conversation is running a turn (message or continuation) |
| `410` | `action_expired` | the request [lapsed](#requests-that-lapse) |

The order is fixed: not found, then not pending (409), then lapsed (410), then who-may-answer (403), then the answer itself (400, 402).

### Answers do not lose each other

A pause can ask several things at once (`pendingActions` has more than one entry). Each answer is recorded against the conversation **as it is when
the answer is written**: the decision is applied to the stored state with a compare-and-set (`StorageProvider.updateConversationIf`, on every
built-in provider), and an answer that meets another one being recorded waits for it - up to `hitl.resolveWaitMs` (3 s) - instead of failing with `409 conversation_busy`.
So the answers to the actions of one pause can be sent at the same time, from one client, two tabs or two server instances: every decision is kept, and
exactly one of the answers (the one that closes the pause) carries the turn on. A second answer to the *same* action finds it answered (`409 action_not_pending`). A message or a continuation takes as long
as the model does, so an answer does not wait for those: `409 conversation_busy`.

Answering is a [run](./runs.md) like a message is: it runs detached from the request (a client that disconnects does not stop it), it can be [cancelled](./runs.md#cancel), and it leaves `action.resolved`, `session.status_running`, ... `session.status_idle` in the conversation's [event log](./runs.md#the-event-log).

## Requests that lapse

A request nobody answers does not wait for ever. Every action gets an `expiresAt`: the one the agent gave its entry, else *now + `hitl.timeoutMinutes`*.

```typescript
createAgentServer({
  basePath: '/api',
  storage,
  hitl: {
    timeoutMinutes: 60,     // default 1440 (a day); 0 = never
    onTimeout: 'deny',      // default; or 'cancel'
  },
});
// one agent can differ
server.registerSDKAgent('ops', agent, {}, { hitl: { timeoutMinutes: 5, onTimeout: 'cancel' } });
```

After the deadline the action answers `410 action_expired` and it is the server's turn (the recovery sweep runs every `runs.sweepIntervalMs`, 60 s by default, and
at the first request; `await server.expirePendingActions()` does it now):

| `onTimeout` | What happens |
|-------------|--------------|
| `deny` (default) | a lapsed approval is answered as a refusal (`comment: "timed out"`, `decidedBy: "system:timeout"`), a lapsed question as skipped. The ones still open stay open. Once nothing is open the agent **carries on** as a run of its own (`session.status_running` with `trigger: "timeout"`): the tool call fails, the agent decides what to do next, and the continuation is a new assistant message. |
| `cancel` | the pause is dropped - the lapsed requests as `expired`, the others as `cancelled` - the agent is not called, and the turn ends with `stopReason: "cancelled"` (`session.status_idle` with `detail: "action_expired"`). The conversation takes a new message. |

The policy is the one the pause was taken with: changing `hitl.onTimeout` later does not change a pause that is already waiting. If the agent can no longer be found, or the
[budget](./budgets.md) is used up, a `deny` pause is cancelled instead (there is nobody to carry on). A task whose request lapses under `cancel` ends `cancelled`; under `deny` it carries on.

The events say it: `action.resolved` with `expired: true`, `resolved_by: "system:timeout"`, `channel: "timeout"` (`status: "rejected"` for a refusal, `"expired"` for a dropped request).

The sweep finds the lapsed requests through the storage provider: `Conversation.actionDueAt` holds the earliest deadline of a conversation's open actions (cleared when nothing waits) and
`getConversations({ actionDueBefore })` lists the due ones. Every built-in provider has it (`capabilities().actionDeadlines`); a [custom provider](./custom-storage.md) without it is still refused with
`410`, and `server.expirePendingActions({ conversationId })` handles a conversation by name.

## Who may answer

By default the owner of the conversation - the rule that guards every conversation route. To let others answer (an on-call approver, a manager), give the server a hook:

```typescript
createAgentServer({
  basePath: '/api',
  storage,
  resolveContext,
  hitl: {
    async authorizeResolve(ctx, { conversation, action }) {
      // ctx is the RequestContext of the person answering
      return ctx.data.role === 'admin' || ctx.user?.id === conversation.userId;
    },
  },
});
```

When the hook is set it decides for **everyone** - the owner too - and the owner check is not applied to the resolve route. `false` is `403 action_forbidden`.
The conversation it gets has the server's internal state removed. Answers by the server itself (a timeout) do not ask the hook.
Who answered is on the record: `resolved_by` on the event, `resolvedBy` on the message, `decidedBy` in the SDK state.

## The record an answer leaves

The assistant message that asked keeps what it asked **and** how it ended, so a history can show approved, denied, answered, expired or cancelled:

```jsonc
// GET /conversations/:id -> messages[1].metadata
{
  "requiresAction": true,           // gone once nothing on the message is open
  "pendingActions": [
    { "id": "ap1", "type": "tool_approval", "toolName": "deploy", "title": "Deploy 1.0?", "args": { "version": "1.0" },
      "expiresAt": "2026-10-12T10:00:00.000Z",
      "status": "resolved",         // pending | resolved | cancelled | expired
      "resolution": { "type": "tool_approval", "decision": "allow", "comment": "ship it" },
      "resolvedBy": "alice", "resolvedAt": "2026-10-11T10:00:12.000Z" }
  ]
}
```

`resolved` covers approved, denied (`resolution.decision`), answered and skipped (`resolution.cancelled`) - the answer itself is `resolution`. `cancelled` is a request withdrawn by a new message
(`pendingActionPolicy: 'cancel'`, `resolvedBy: "system"`) or by `POST .../cancel`; `expired` a request that lapsed under `onTimeout: 'cancel'`.
The record is written with `StorageProvider.updateMessage`, which every built-in provider has. A provider without it still works; its history just keeps showing the request as it was asked
(the event log has the decisions either way).

## Edited arguments are checked

`approvedArgs` replaces the arguments of the tool call, so the server checks them before the agent sees them. For an agent-sdk agent it finds the tool in `agent.__runtime.tools` and checks the
arguments against its schema: a **zod** schema (`tool.schema`) or a **JSON Schema** (`parameters`, `inputSchema`, `input_schema`; `type`, `required`, `properties`, `additionalProperties`, `enum`, `const`,
bounds, `pattern`, `items`, `anyOf` / `oneOf` / `allOf` are understood). A mismatch is `400 invalid_approved_args` naming the field, and the request stays pending.

Nothing is checked when the arguments are the very ones that were asked, when the answer is a refusal, when the tool declares no schema, or when `hitl.validateApprovedArgs` (server or agent) is `false`.

## Remembered tools

`rememberForSession: true` on an approval makes the agent skip the approval for later calls of that tool in the conversation (by tool name; a tool whose `needsApproval` is a per-call
predicate is never remembered; `allowRememberApproval: false` turns it off). It is no longer silent:

- every call that went through on that memory is an `action.resolved` event with `resolved_by: "remembered"`, `channel: "remembered"`, `remembered: true` and the `tool_name`;
- `GET /conversations/:id/remembered-tools` lists them (also `conversation.rememberedTools`);
- `DELETE /conversations/:id/remembered-tools/:tool` forgets one: the next call asks again (`404` when it is not remembered). A tool forgotten while a turn runs stays forgotten.

## Events

A pause and its resolution are in the event log, so a client that was not connected can follow them (`GET /conversations/:id/events/stream`):

```
action.required   { action_id, kind: 'tool_approval' | 'user_question', tool_name?, summary?, args?, questions?, allow_free_text?, expires_at? }
session.status_idle { stop_reason: 'requires_action', pending_action_ids: [...] }
action.resolved   { action_id, kind, decision?, cancelled?, expired?, remembered?, edited_args?, remember_for_session?, status: 'approved' | 'rejected' | 'answered' | 'cancelled' | 'expired', resolved_by, channel: 'api' | 'system' | 'timeout' | 'remembered' }
```

`GET /conversations/:id` has `runtime.status: "requires_action"` and `runtime.pendingActionIds` while a pause is open.

## Cancelling a pause

`POST /conversations/:id/cancel` on a conversation that waits on a human cancels what it waits on: an `action.resolved` event (`cancelled: true`) for
each open action, then `session.status_idle` with `stop_reason: "cancelled"`; the paused message records each as `cancelled`. The conversation is free for a new message; resolving the old actions is a `409 action_not_pending`.

## A message while an action is pending

By default the server answers `409 action_pending` (with `error.details.pendingActionIds`) and does nothing. Set `pendingActionPolicy: 'cancel'` to cancel the pending actions instead (each one gets a `action.resolved` event with `cancelled: true`, `resolved_by: "system"`, and shows as `cancelled` on the paused message) and process the message normally:

```typescript
createAgentServer({ basePath: '/api', storage, pendingActionPolicy: 'cancel' });
```

## SDK agents

`registerSDKAgent` works unchanged. When `invoke` returns a state with pending approvals (tools created with `needsApproval`) or pending user questions (`humanInTheLoop: { askUser }`), the server:

- stores the paused state (`result.state`, without live objects) in the conversation state - hidden from every API response;
- resolves with the agent's own `resolveToolApproval` / `resolveUserQuestion` and calls `invoke` again with the same streaming hooks (it does not use `resume`).

`AgentInfo.capabilities` (`{ toolApproval?, askUser? }`) is derived from the agent instance when possible, or pass `capabilities` in the registration info.

The paused state lives in `Conversation.state`, so use a persistent storage provider if a pause must survive a restart. Every built-in provider
keeps it across a restart (a new server on the same database resolves a pause started by the old one).

**It has to fit.** A long transcript or big tool results make a big state, and a store holds only so much (MongoDB: 12 MiB by default, see
[Storage Providers](./storage.md)). When the state would not fit - `limits.maxStateBytes`, or the provider's own limit, whichever is smaller -
the server does **not** pause the turn. It finishes instead: the assistant message gets `metadata.warnings` with a `pause_state_too_large` entry (also `warnings`
on the response and on `stream.done`), no action is left pending, and the tool call is not carried out. A turn that gets that far is never stranded
half-written: if the store refuses the write, the assistant message is taken back out.

## Custom handlers

Return `status` and `pendingActions` from `processMessage`, and implement `resolveAction`:

```typescript
agentServer.registerCustomAgent('payments', {
  async processMessage({ message }) {
    return {
      content: 'I need your approval first.',
      status: 'requires_action',
      pendingActions: [{ id: 'pay_1', type: 'tool_approval', toolName: 'wire', args: { amount: 5 } }],
    };
  },
  async resolveAction({ actionId, resolution }) {
    if (resolution.type === 'tool_approval' && resolution.decision === 'allow') {
      return { content: 'Sent.' };
    }
    return { content: 'Cancelled.' };
  },
}, { name: 'Payments', capabilities: { toolApproval: true } });
```

`pendingActions` is the complete set still waiting after the call: return the remaining ones from `resolveAction` if you paused on several, or nothing when the turn is done. A handler without `resolveAction` cannot be resolved (404).

## Host-backed agents

An agent whose work runs in your own backend returns `pendingActions` from `invoke` (or emits `action_required`) and implements `resolveAction`, which is called once per answered action with the whole
answer. The server stores the pause, applies the timeouts and `authorizeResolve`, records who decided what on the message, and writes the same events. What it leaves to the host: remembering a tool for
the session (`rememberForSession` arrives in the resolution) and checking `approvedArgs` against a schema. See [Host-backed agents](./host-agents.md#approvals-and-questions).

## Not covered

Chat Completions and Responses API agents never pause. A pause that has a deadline needs the expiry sweep to be running (the default) or `server.expirePendingActions()` called from your own scheduler; without
either, a lapsed request is only refused with `410`.

A handler that does not honour `signal` is abandoned `runs.cancelGraceMs` after a cancel - see [Runs, Cancel & Reattach](./runs.md#cancel).
