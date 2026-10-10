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

- `approvedArgs` must be a JSON object; it replaces the tool arguments when allowing.
- `rememberForSession` (SDK agents): later pauses on the same tool in this conversation are approved automatically.
- Answers are matched to options by value or label; anything else counts as free text (only valid when the question allows it).

Errors: `400` malformed or invalid resolution (nothing is consumed - answer again), `404` conversation not found or the agent cannot resolve actions, `409 action_not_pending` for an unknown, already resolved or currently-resolving action.

## A message while an action is pending

By default the server answers `409 action_pending` (with `error.details.pendingActionIds`) and does nothing. Set `pendingActionPolicy: 'cancel'` to cancel the pending actions instead and process the message normally:

```typescript
createAgentServer({ basePath: '/api', storage, pendingActionPolicy: 'cancel' });
```

## SDK agents

`registerSDKAgent` works unchanged. When `invoke` returns a state with pending approvals (tools created with `needsApproval`) or pending user questions (`humanInTheLoop: { askUser }`), the server:

- stores the paused state (`result.state`, without live objects) in the conversation state - hidden from every API response;
- resolves with the agent's own `resolveToolApproval` / `resolveUserQuestion` and calls `invoke` again with the same streaming hooks (it does not use `resume`).

`AgentInfo.capabilities` (`{ toolApproval?, askUser? }`) is derived from the agent instance when possible, or pass `capabilities` in the registration info.

The paused state lives in `Conversation.state`, so use a persistent storage provider if a pause must survive a restart.

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

## Not covered

Expiry/timeouts are not enforced by the server; `expiresAt` is passed through for the UI. Chat Completions and Responses API agents never pause.
