# Usage & Budgets

The server reports what every turn used and, when it knows the prices, what it cost. A conversation can have a **budget**: a limit on what its turns cost in total. When it
is used up the turn stops, the conversation waits, and a person can raise the limit and carry on.

Nothing here changes an agent that has no `pricing`: it reports tokens as before and has no budget.

## Usage of a turn

`usage` on a message response, on `stream.done` and in the `session.usage` event is what **this turn** used:

```json
{ "inputTokens": 1200, "outputTokens": 310, "totalTokens": 1510, "cachedInputTokens": 800, "costUsd": 0.0123 }
```

An agent-sdk agent reports its usage as a ledger: one entry per model call and totals per model, **cumulative over the life of a state**. A turn that paused for an
approval and was resumed hands back the ledger of the whole turn, the calls before the pause included. The server subtracts the ledger the run started from,
so each run reports only what it used itself: the message that paused reports the calls up to the pause, the answer that carried the turn on reports the calls after it, and nothing is counted twice.
Chat Completions and Responses API agents report their provider's usage; a [custom handler](./custom-agents.md) returns `usage: { inputTokens, outputTokens, totalTokens }` and may add
`costUsd` (what the turn cost) or `model` (so the server can price the tokens). A [host-backed agent](./host-agents.md#usage-and-budgets) does the same with `usage` events or the `usage` of its result.
Neither a handler nor a host agent can be stopped in the middle of a turn by the budget (there is no cap to hand it): the turn that crosses the budget completes and the next message is refused.

## Prices

`costUsd` needs to know what a token costs. Give the server a `pricing` function - model name in, price per token out:

```typescript
import { createAgentServer } from '@cognipeer/agent-server';

createAgentServer({
  basePath: '/api',
  storage,
  pricing: (model) =>
    model === 'gpt-4o' ? { inputPerToken: 2.5e-6, outputPerToken: 10e-6, cachedInputPerToken: 1.25e-6 } : undefined,
});
```

The model name is the one agent-sdk reports in its ledger (Chat Completions / Responses agents: the `model` of their config). A model `pricing` returns `undefined` for is not priced; if none
of a turn's models is priced there is no `costUsd` and the turn adds nothing to the conversation's total. One agent can have its own prices: `server.registerSDKAgent(id, agent, info, { pricing })`.

The conversation's total is `conversation.spentUsd` (and `spentUsd` next to `usage` on every response). It grows with every priced turn, whether the conversation has a budget or not,
and counts a turn that was cancelled.

## Budgets

```typescript
createAgentServer({
  basePath: '/api',
  storage,
  pricing,
  budget: { maxCostUsd: 5, onReach: 'pause' },   // every new conversation starts with it
});

// one agent can differ ...
server.registerSDKAgent('research', agent, {}, { budget: { maxCostUsd: 50, onReach: 'stop' } });
// ... or have none
server.registerSDKAgent('cheap', agent, {}, { budget: null });
```

A budget needs prices: a budget on an agent nothing can price is refused when the agent is registered (and `400 budget_unavailable` when a client asks for one).

| `onReach` | When the limit is reached |
|-----------|---------------------------|
| `pause` (default) | the conversation waits. `runtime.status` is `budget_paused`. Raise the budget, then `POST /conversations/:id/continue` carries the stopped turn on (when the turn was cut short; see `continuable` below). |
| `stop` | the conversation ends: `runtime.status` is `idle`, nothing is kept to carry on from, and every further message is refused until the budget is raised. |

### What happens when it is reached

- **Before a turn** (a message, an answer that lets the agent run again, a continuation): if nothing is left, the model is not called and nothing is stored: `402 budget_reached` with
  `error.details: { spentUsd, maxCostUsd, onReach }`.
- **During a turn**: agent-sdk is given the room that is left as its own `limits.maxCostUsd` and stops *before the next model call* once the turn's cost is above it, so a turn
  overshoots by at most one model call. agent-sdk can only price its calls if the agent was built with a `costEstimator`; use the same prices:

  ```typescript
  import { costEstimatorFromPricing } from '@cognipeer/agent-server';
  const agent = createSmartAgent({ model, tools, costEstimator: costEstimatorFromPricing(pricing) });
  ```

  Without one the SDK's cost limit does nothing and the budget applies **between** turns: the turn that crosses it completes, and the next one is refused.
- **After a turn**: the cost is added to `spentUsd`. A turn the budget stopped, or that finished above it, ends with `stopReason: "budget_reached"`; the events are `budget.reached`
  `{ spent_usd, max_cost_usd, on_reach }` and `session.status_idle` `{ stop_reason: "budget_reached" }`. A turn the budget cut short is `incomplete`; one that only crossed the line
  keeps its answer and is `completed`. A turn that paused for a person or was cancelled keeps its own stop reason (the next turn is refused all the same).
- A [task](../tasks.md) cut short by its budget fails; one that only crossed it completes.

### Raising it, and carrying on

```http
PATCH /conversations/conv_1
{ "budget": { "maxCostUsd": 20, "onReach": "pause" } }     # or "budget": null to remove it

POST /conversations/conv_1/continue                          # { "stream": true } to stream
```

- **Lowering** a budget is the owner's to do. **Raising or removing** one (a higher limit, `pause` where it was `stop`, `null`) goes through the `authorizeBudget` hook, and without it the answer is `403 budget_forbidden`:

  ```typescript
  createAgentServer({
    // ...
    authorizeBudget: (ctx, { conversation, current, requested, spentUsd }) => ctx.data.role === 'admin',
  });
  ```
- A new limit has to be above what the conversation has spent (`400 invalid_budget`). The same rules apply to `budget` in `POST /conversations`, measured against the agent's default.
- `continue` resumes the agent from the state the budget stopped it in, with no new message; the continuation is a new assistant message and only reports what it used itself.
  `402 budget_reached` while the budget is still used up, `409 action_pending` while the conversation waits on a person, `409 nothing_to_continue` when there is nothing to carry on (`onReach: "stop"`,
  a turn that only crossed the line, or the turn was already carried on). Only agent-sdk agents can be continued: the stopped state is kept next to the conversation's pause state and counts against `limits.maxStateBytes`.
- A new message instead of `continue` discards the stopped state and starts a fresh turn.

**`continuable`** tells a client whether there is a stopped turn to carry on. `GET /conversations/:id`, the conversations list and the `PATCH` answer carry it next to `runtime`:

| The last turn | `runtime.status` | `continuable` | After a raise |
|---------------|------------------|---------------|---------------|
| was cut short by the budget (`incomplete`, `onReach: "pause"`) | `budget_paused` | `true` | still `budget_paused` and `true`: `POST .../continue` resumes it, or a new message gives it up |
| finished its answer, and crossed the limit | `budget_paused` while the budget is used up | `false` | `idle`, `false`: the raise only reopens the conversation, there is nothing to carry on |
| was carried on, or superseded by a new message | `idle` | `false` | |

A client's "Increase and continue" is therefore: `PATCH` the budget, call `continue` only if the answer says `continuable: true`, then read the conversation again (`spentUsd`, `runtime`). Before `continuable` existed a client had
to guess from `runtime.status`, and a raise turned a cut-short turn's `budget_paused` into `idle`, which looked like nothing to continue.

Every conversation shows `budget` and `spentUsd` (`GET /conversations`, `GET /conversations/:id`), and `runtime.status` is `budget_paused` while it waits on its budget.

## Where it is kept

The budget and the total live in the conversation's internal state, next to the pause state, and are written together with the turn they belong to. They are written with a compare-and-set,
so a budget change while a turn runs, or two turns' bookkeeping, never overwrite each other. A conversation inherits its agent's budget until something is written to it; after the first priced turn it keeps its own copy.
