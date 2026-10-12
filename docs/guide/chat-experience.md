# Chat experience

The pieces a chat product needs around a conversation, served by the same routes for every agent kind: **regenerate** an answer, **edit** a message and resend, **pin**, **rename** and **bulk-delete** conversations, **generated titles**, **starters** and a **welcome** text, **feedback** on answers, and **export**.
A chat client (such as [`@cognipeer/chat-ui`](https://www.npmjs.com/package/@cognipeer/chat-ui)) reads what an agent offers from `GET /agents` and calls these routes. Everything is additive: until you set something, the existing routes behave as before and the new ones are there, switched on.

## Switches

What a chat client shows around an agent is one setting, `experience`, on the server and on each agent. The agent's fields override the server's; what a host writes in `AgentInfo.metadata.experience` overrides both, field by field.

```typescript
createAgentServer({
  basePath: '/api',
  storage,
  experience: {
    history: { bulkDelete: false },            // for every agent
    feedback: { comments: false },
  },
});

server.registerSDKAgent('support', agent, { name: 'Support' }, {
  experience: {
    welcome: 'Hi! I can **look up orders** and answer questions about shipping.',
    starters: [
      { text: 'Where is my order?', label: 'Track an order' },
      { text: 'How do I return an item?', autoSend: true },
    ],
    messageActions: { edit: false },           // no edit-and-resend for this agent
    export: { includeTools: true },
  },
});
```

| Field | Default | |
| --- | --- | --- |
| `welcome` | none | Shown on the empty state. Markdown, at most 4000 characters. The server does not interpret it - substituting names is the host's job |
| `starters` | none | Up to 6 `{ text, label?, autoSend? }`: suggested first messages. `text` is put in the composer (sent at once with `autoSend`); at most 500 characters, `label` 80 |
| `messageActions` | `copy`, `regenerate`, `edit`: all on | What a message offers |
| `history` | `rename`, `pin`, `bulkDelete`: all on | What the conversation list offers |
| `feedback` | on; `comments` on; the default reasons | Thumbs up / down. `enabled: false` also makes the route answer 403 |
| `export` | on; `includeTools` off | Download a conversation |

`GET /agents` publishes the result in `metadata`, so a client needs no configuration of its own:

```jsonc
{
  "id": "support",
  "metadata": {
    "welcome": "Hi! I can **look up orders** ...",
    "starters": [{ "text": "Where is my order?", "label": "Track an order" }, { "text": "How do I return an item?", "autoSend": true }],
    "experience": {
      "messageActions": { "copy": true, "regenerate": true, "edit": false },
      "history": { "rename": true, "pin": true, "bulkDelete": false },
      "feedback": { "enabled": true, "comments": false, "reasons": ["inaccurate", "incomplete", "off_topic", "too_long", "unsafe", "other"], "maxCommentLength": 0 },
      "export": { "enabled": true, "includeTools": true, "formats": ["md", "json", "html"] },
      "titles": false
    }
  }
}
```

The routes **enforce** the same switches: a regeneration of an agent with `messageActions.regenerate: false` is `403 action_disabled` (`error.details.setting` names the switch), feedback is `403 feedback_disabled`, an export `403 export_disabled`.
A host that builds its agents per request (`config.agents`) puts the portal's own settings in the registration's `experience` and gets the same behaviour.

**An agent that cannot be resolved** (it left the registry or the host's catalog, or the host's `agents` function failed) has no settings to read, and the server does not stand in with its own defaults, which are all on. For a conversation of such an agent, exporting, rating, renaming, pinning and bulk deleting are refused with the same codes as a switched-off action, and `error.details.reason` is `agent_unavailable`; regenerating and editing are `404` as before. Reading the conversation and deleting it one at a time keep working, so a person can still see and clear their own history. The agent coming back brings its switches back.

## Message actions

### Regenerate

```http
POST /conversations/conv_1/messages/msg_9/regenerate
```

Runs the **newest** answer again. The turn starts from the user message that answer replied to - the same agent, the transcript cut back to that message - and the new answer replaces the old one. It keeps what the earlier answers said in `metadata.previousContent` (newest last,
at most 5) and the id of the answer it replaced in `metadata.regeneratedFrom`, so a client can offer "previous versions". The old answer is removed only **after** the new one is stored: a turn that fails loses nothing.

- Only the newest message of the conversation can be regenerated (`409 invalid_message_target`, `details.reason: "not_newest"`). After a turn that failed and left no answer, name the **user message** to run it again.
- It is a turn like any other: one at a time per conversation (`409 conversation_busy`), the [budget](./budgets.md) applies (`402`), and a conversation with an open approval says `409 action_pending`.
- A host-backed agent or a custom handler hears `mode: "regenerate"` and `fromMessageId` (the answer being replaced) next to the user's `message`; its `history` is already cut back. A backend that keeps its own transcript rewinds it to that message.
- The event log gets `session.status_running` with `mode: "regenerate"`, and - once the new answer is stored and the old one is gone - `session.truncated`, just before the new answer's `agent.message`. A second window that follows the conversation reloads its history when it sees `session.truncated`.
- With `"stream": true` the answer streams exactly as a message does; `stream.start` carries the id of the user message.

### Edit and resend

```http
POST /conversations/conv_1/messages/msg_3/edit
{ "content": "What is the weather in Izmir?" }
```

Replaces a **user** message. The new text is stored as a new user message (`metadata.edited`, `editedFrom`, `previousContent`), the old message **and everything after it** are removed, and a new turn runs from it.

- Files: without `fileIds` and `files` the message keeps its files; `fileIds: []` drops them. A file that no remaining message carries is deleted, so it neither fills the conversation's file limit nor rides along with the next message.
- A host agent / handler hears `mode: "edit"` and `fromMessageId` (the user message that was replaced).
- If the conversation's title was [generated](#generated-titles) and the edited message was the first one, the title is made again after the answer.
- The log gets `session.truncated`, then `user.message` (`edited: true`), then the turn's own events.

## History

| | |
| --- | --- |
| **Rename** | `PATCH /conversations/:id { "title": "..." }`: trimmed, at most 200 characters, `""` clears it. A title the person wrote is never replaced by a generated one |
| **Pin** | `PATCH /conversations/:id { "pinned": true }`. The conversation shows `pinned: true`, and `GET /conversations` lists pinned conversations **first**, each group in the requested order, across pages (`?pinned=none` turns that off). Pins live in `metadata.pinned`, which only the server writes: a client cannot set or drop it through `metadata` |
| **Bulk delete** | `POST /conversations/bulk-delete { "ids": [...] }` (up to `limits.maxBulkDelete`, default 100): one result per id (`deleted`, `not_found`, `busy`, `error`). Someone else's conversation is `not_found`, exactly like one that does not exist |

Pin order is a property of the storage provider: the four built-in providers order pinned conversations first inside the query (`capabilities().pinnedFirst`), so paging stays correct. A [custom provider](./custom-storage.md) without it only gets the pinned conversations moved to the top of the page it returned.

**The experience flags in `metadata` come from the server.** `pinned`, `pinnedAt` and `titleGenerated` are written by the server alone, through `pinned` and the title routes; what a client puts under those names in `metadata` (on create or on update) is dropped, and an update of `metadata` leaves the ones the conversation has as they are. A host that keeps conversations in its own store reports them back in the conversation's `metadata` (a pin as `pinned: true` with `pinnedAt`), and treats them as read-only.

`PATCH /conversations/:id` answers the conversation **as the update left it**, not as the store happens to echo it. A host's `updateConversation` may return a record that still carries what the update took away (the pin, right after an unpin) or leaves out what it put there; the answer is the stored record with the metadata the update wrote laid over it: keys the store added itself stay, what the update wrote is what it wrote, and `pinned` / `pinnedAt` / `titleGenerated` that the update did not write are not in the answer (so is the top-level `pinned`). A later `GET` is the store's own word.

## Generated titles

`titleGeneration` makes a short title after the **first answer** of a conversation that has none: at most `maxWords` words (default 6), in the language of the conversation, from the first message and the first answer. Either point it at an OpenAI-compatible endpoint, or give it a function when you have
your own model access, accounting and limits:

```typescript
createAgentServer({
  basePath: '/api',
  storage,
  titleGeneration: { baseUrl: 'https://api.openai.com', apiKey: process.env.OPENAI_API_KEY!, model: 'gpt-4o-mini', maxWords: 5 },
});

// one agent differs: its own generator (counted to the person in your own books), or none at all
server.registerSDKAgent('billing', agent, {}, {
  titleGeneration: {
    async generate({ user, assistant, maxWords, signal, context }) {
      const { title, usage } = await myModels.small.title({ user, assistant, maxWords, signal });
      return { title, usage, model: 'small' };
    },
  },
});
server.registerSDKAgent('scratch', agent, {}, { titleGeneration: false });
```

- The call is bounded (`timeoutMs`, default 10 s) and stops when the turn is cancelled; a title that does not arrive is skipped.
- The title is returned in `conversationTitle` / `stream.done.title`, stored on the conversation with `metadata.titleGenerated: true`, and announced by a **`session.title`** event: `{ title, purpose: "title", model?, usage? }`. The `purpose` tag is what lets a host count the call to the person's usage separately from the turn.
- Regenerating or editing does not re-title, except as described under [Edit and resend](#edit-and-resend).

## Feedback

```http
POST /conversations/conv_1/messages/msg_9/feedback
{ "rating": "down", "reasons": ["inaccurate"], "comment": "The date was wrong" }
```

Thumbs up / down on an **answer** (`rating: null` withdraws). On `down` the person can pick reasons - codes from `feedback.reasons`, by default `inaccurate`, `incomplete`, `off_topic`, `too_long`, `unsafe`, `other` (an agent or the server can replace the list) - and add a comment of at most
`feedback.maxCommentLength` characters (default 1000; `0` takes the comment box away). One rating per message: a new one replaces the old. It needs no turn lease, so a person can rate while another turn runs.

The rating is stored on the message (`metadata.feedback`) and the API shows it as the message's `feedback`, so a reloaded client shows the thumb that was pressed. To keep your own record, implement `feedback(event)` on a [host agent](./host-agents.md#feedback) or give the server an `onFeedback` hook:

```typescript
createAgentServer({
  basePath: '/api',
  storage,
  feedback: {
    reasons: ['wrong', 'rude', 'slow'],
    async onFeedback(ctx, event) {
      // event.rating: 'up' | 'down' | null, event.reasons, event.comment, event.message (the answer), event.question (what it answered),
      // event.messageIndex, event.previous (the rating this replaced), event.userId
      await analytics.record(ctx.data.tenant, event);
    },
  },
});
```

The hook is awaited and its failure fails the request - the rating stays on the message, and repeating the request is safe.

## Export

```http
GET /conversations/conv_1/export?format=md&locale=tr
```

| `format` | |
| --- | --- |
| `md` (default) | Markdown: title, who said what and when, the text, the names of attached files |
| `json` | `{ schemaVersion, exportedAt, conversation, messages }` - with files, ratings and (with `tools=1`) the tool calls of each answer |
| `html` | A print-friendly page. With `print=1` it opens the browser's print dialog once loaded: **Save as PDF** |
| `pdf` | Only when the server has `export.renderPdf` (otherwise `501 export_format_unsupported`) |

**Why no built-in PDF?** A PDF writer that sets Turkish, Greek or CJK text correctly needs fonts and a layout engine; that is not something to hide in a dependency-free server. A host that has one (puppeteer, playwright, wkhtmltopdf ...) plugs it in:

```typescript
createAgentServer({
  basePath: '/api',
  storage,
  export: {
    includeTools: false,                       // tools=1 is refused (403 export_disabled) unless an agent turns it on
    maxMessages: 5000,                         // a longer conversation is cut at the newest messages, and the file says so
    labels: { de: { user: 'Sie', assistant: 'Assistent' } },   // en and tr are built in; ?locale=de picks yours
    renderPdf: async ({ html }) => htmlToPdf(html),
  },
});
```

`GET /agents` lists the formats an agent can export (`experience.export.formats`), so a client offers "Download PDF" only when the server renders one and falls back to "Print / Save as PDF" (`html` + `print=1`) otherwise.

The HTML page escapes every message (nothing a person or a model wrote is ever markup) and is served with a `Content-Security-Policy` that allows no network, no frames and - with `print=1` - exactly one script, the one that opens the print dialog.
Tool calls come from the event log (name, arguments, result status, duration; never the tool's output) and are included only when `tools=1` **and** the agent allows it. Every export reaches the [`audit` hook](./embedding.md#audit).

The calls of a turn are put with its answer by the run that wrote them. A host that keeps its own log - one whose events carry **no run id** - gets the same result from the order the events were written in: the calls between a question (`user.message`) and the answer after it are that answer's. Which stored message an answer is: the one it names (`message_id`), else the one at the position it reports (`message_index`, an index into the whole transcript), else the one that says the same text (`content`), else - when it says nothing about itself - the answers are lined up with the stored ones from the newest back (a log that lost its oldest events still gives the newest answers their calls). Fields are read as `tool_call_id` or `toolCallId`, `duration_ms` or `durationMs`. An answer that matches no stored message (one that was regenerated away), and a log with more answers than the transcript has and nothing to tell them apart, show no calls rather than another answer's.

## Next Steps

- [Embedding & limits](./embedding.md) - bearer auth for chats embedded in other sites, the rate-limit and audit hooks
- [Approvals & Questions](./human-in-the-loop.md) - including [client tools](./human-in-the-loop.md#client-tools)
- [Runs, Cancel & Reattach](./runs.md) - the event log these routes write to
