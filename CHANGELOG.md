# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.0] - 2026-10-10

Human-in-the-loop: agents can pause for a tool approval or a question, and a client resumes them. The pause protocol is additive: an agent that never pauses behaves as before. The storage providers were also brought in line with one tested contract, which changes a few behaviours that used to differ between them (see Changed and Fixed).

### Added

- **Pending actions** (`PendingAction`, `ActionResolution`, `UserQuestion`, `MessageStatus`): a turn can end with `status: "requires_action"` and the list of `pendingActions` it waits on.
- **Resolve route** `POST /conversations/:conversationId/actions/:actionId` with `{ resolution, stream? }`. Streams the continuation (`stream.start`, `stream.action_resolved`, ... `stream.done`) or answers JSON. 404 when the agent cannot resolve actions, 409 `action_not_pending` for an unknown / already resolved action, 400 for an invalid resolution.
- **Stream events** `stream.action_required` and `stream.action_resolved`; `stream.done` and the non-stream message response gained optional `status` / `pendingActions` (only sent when the turn did not complete).
- **SDK agents**: a paused `invoke` result (pending approvals / user questions) is persisted in the conversation state; resolving restores it, applies the decision with `resolveToolApproval` / `resolveUserQuestion` and calls `invoke` again with the same streaming hooks. `rememberForSession` auto-approves later pauses on the same tool in that conversation.
- **Custom handlers**: `ProcessMessageResult.status` / `pendingActions` pass through; new optional `AgentHandler.resolveAction(params)` continues the turn.
- `GET /conversations/:id` returns `pendingActions`; internal pause state is never exposed in `conversation.state`.
- **`pendingActionPolicy`** (`'reject'` default | `'cancel'`): what a new message does while an action is pending (409 `action_pending`, or cancel the pending actions and proceed).
- `AgentInfo.capabilities` (`toolApproval`, `askUser`), derived for SDK agents when cheaply knowable.
- OpenAPI schemas and path for the new route; docs guide "Approvals & Questions".
- **Attach uploaded files by id**: `SendMessageRequest.fileIds` (files uploaded with `POST /files` and `conversationId`). Each id is resolved through `storage.getFile` before the turn starts (404 for an unknown file or one of another conversation, 400 for a malformed list or more than `limits.maxFiles`); the user message carries the stored records. Inline `files` keep working.
- Fastify adapter option `uploadBodyLimit`: the body limit of `POST /files` alone, every other route keeps `bodyLimit`.
- `NodeHandlerOverrides.error`: answer with a given `{ statusCode, code, message }` instead of routing, through the usual CORS headers and error envelope.
- **Storage provider contract suite** (`test/storage/contract.ts`, `runStorageContract`) run against memory, SQLite, MongoDB and PostgreSQL with real databases (mongodb-memory-server, a throwaway PostgreSQL container, or `MONGODB_URL` / `PG_URL`), and the HITL tests re-run over all four, including a simulated restart in the middle of a pause. CI runs it against service containers with `REQUIRE_ALL_PROVIDERS=1`.
- **`StorageProvider.capabilities()`** (`{ maxFileBytes, maxStateBytes, atomicUpdate, events, leases }`, optional) on every built-in provider. `createAgentServer` throws when `limits.maxFileSize` / `limits.maxStateBytes` exceed it; the default upload limit is capped at what the provider can hold.
- **`limits.maxStateBytes`**: a turn whose paused state would not fit (this value or the provider's limit, MongoDB: 12 MiB by default) is not paused. It finishes with a `pause_state_too_large` warning (`metadata.warnings`, `warnings` on the response and `stream.done`) instead of failing after the message was written; an assistant message is never left behind when the pause could not be stored.
- **MongoDB: GridFS** (bucket `<prefix>files`) holds the content of every file, so files are no longer limited to 16 MiB; content stored by older versions in `<prefix>file_contents` is still read. `maxStateBytes` option (default 12 MiB, at most 15 MiB) for the conversation state, measured as BSON.
- **`StorageLimitError`** (413 `STORAGE_LIMIT_EXCEEDED`); providers answer too-large files and states with it, over-long values with `ValidationError` (400) and unknown parents with `NotFoundError` (404), not with driver errors.
- **Paged history**: `GET /conversations/:id` takes `limit`, `before`, `after` (message ids) and `order`, and answers `messagesPage` (`hasMoreBefore` / `hasMoreAfter`). `GetMessagesParams.before` / `after` for storage providers. `limits.messagePageSize` (default 100) and `limits.maxPageSize` (default 200).
- `GET /conversations` takes `orderBy=updatedAt` (last activity) and `order=asc`; the default is unchanged (newest created first).
- Schema versioning for the SQLite and PostgreSQL providers (`<prefix>meta`), upgrades run once; PostgreSQL migrates under an advisory lock.
- `eslint.config.js`, so `npm run lint` runs.
- **Detached runs** ([guide](docs/guide/runs.md)): a turn (a message or a resolved action) now runs as a run that is independent of the HTTP request that started it. A client that disconnects - closing the tab, a dropped connection, a proxy timeout - no longer stops the turn: the agent finishes, the assistant message and any pending approval are stored, and the conversation is free again. A streamed request is only a subscriber of its run. Adapters call the new `RouteResult.close` when the client goes away so the stream ends at once.
- **Cancel**: `POST /conversations/:id/cancel` aborts the running turn (`200`, or `202` with `settled: false` while it winds down or runs on another node). agent-sdk agents receive the abort signal as their `cancellationToken`, custom handlers as the new `signal` of `ProcessMessageParams` / `ResolveActionParams`, Chat Completions / Responses API requests as the `fetch` signal. The text streamed so far is kept as the assistant message (`status: "cancelled"`); an agent that ignores the signal is abandoned after `runs.cancelGraceMs`. A conversation that only waits on a human has its open actions cancelled. Deleting a running conversation cancels its run first.
- **One turn at a time**: a second message or answer while the conversation runs a turn is `409 conversation_busy` (`error.details.activeRunId`), also for a streamed request (a real HTTP status). Enforced in-process and - with a storage provider that has leases - across server instances.
- **Event log** on every built-in provider (`StorageProvider.events`: `append`, `list`, `summary`, `prune`; `capabilities().events` is `true`), in the Console client vocabulary (snake_case): `user.message`, `session.status_running`, `agent.tool_use`, `agent.tool_result`, `agent.message`, `action.required`, `action.resolved`, `session.usage`, `session.status_idle`, `session.work_done`, `session.error`. `(conversationId, seq)` is unique, `seq` ascends without gaps - also for concurrent appenders - and keeps counting after a restart or a prune. A provider without `events` gets a bounded in-memory log (`runs.memoryEventLimit`, 2 000 per conversation).
- `GET /conversations/:id/events?after&types&limit` (`{ events, hasMore, lastSeq }`) and `GET /conversations/:id/events/stream` (SSE: `id: <seq>`, `Last-Event-ID` / `?after`, `: ping` every 15 s, `agent.message.delta` frames for streamed turns). The stream subscribes before it replays, so nothing stored during the replay is missed or sent twice; events written by another node arrive by polling.
- **`seq` on `stream.*` frames** (the event-log cursor at that frame) and `stopReason` / `runId` on `stream.done` and on the message and resolve responses. A client that loses a message stream resumes with `events/stream?after=<seq>`.
- **Conversation runtime**: `conversation.runtime` on `GET /conversations/:id` and in `GET /conversations` - `{ status: 'idle' | 'running' | 'requires_action' | 'budget_paused', stopReason, lastEventSeq, pendingActionIds, activeRunId }`. Assistant messages carry `status` (API) and `metadata.status` / `metadata.stopReason` (`end_turn`, `requires_action`, `cancelled`, `max_turns`, `limit`, `budget_reached`, `error`). A custom handler can report `stopReason` itself; an SDK result with `state.ctx.__cancelled` / `__limitBreached` is mapped to `cancelled` / `limit`.
- **Leases** on every built-in provider (`acquireLease`, `renewLease`, `releaseLease`, `getLeases`, `markLeaseCancel`, `listExpiredLeases`; `capabilities().leases` is `true`): atomic, time-limited claims, taken over after they expire. The server holds `conv:<id>` for the length of a run and renews it; `POST .../cancel` reaches a run on another node through the lease.
- **Recovery**: a run whose server died is closed when its lease has expired - `session.error` (`code: "run_interrupted"`) and `session.status_idle` with `stop_reason: "error"` - by the next message to the conversation or by the sweep (at the first request and every `runs.sweepIntervalMs`); `server.recoverStaleRuns()` runs it on demand, `server.close()` stops the sweep. A task left `running` by a process that is gone is failed. Events older than `runs.eventRetentionDays` (30) are pruned.
- **Tasks run in a conversation**: `task.conversationId`, filterable with `GET /tasks?conversationId=`; the agent's pause makes the task `waiting_for_input` with `pendingActions` on `GET /tasks/:id` (answered on the conversation, which completes the task); new status `cancelled` and `POST /tasks/:taskId/cancel`; a comment on a running task is `409 task_busy`, on one waiting on an action `409 action_pending`.
- `AgentServerConfig.runs` (`RunsConfig`) with `nodeId`, `leaseTtlMs`, `cancelGraceMs`, `cancelWaitMs`, `pingIntervalMs`, `followPollMs`, `maxStreamMs`, `eventPageSize`, `maxEventPageSize`, `maxEventDataBytes`, `memoryEventLimit`, `eventRetentionDays`, `sweepIntervalMs`, `recoverOnStart`, `assumeSingleNode`.
- Exports: `EventStore`, `ConversationEvent`, `Lease` & co, `StopReason`, `ConversationRuntime`, `RunsConfig`, `EVENT_TYPES`, `MemoryEventLog`, `nextStopReason`, `EventQuery`, `StoredEventInput`. OpenAPI paths and schemas for all of it; the contract suite covers events, leases and the task link on memory, SQLite, MongoDB and PostgreSQL.

- **Files the agent reads** ([guide](docs/guide/file-management.md)). The `files` server option (`FilesConfig`) and a per-agent override (`AgentRegistration.files`, the new last argument `{ files }` of `registerSDKAgent` / `registerCustomAgent` / `registerChatCompletionsAgent` / `registerResponsesAgent`): `enabled`, `maxFiles` (per conversation), `maxFileSize`, `allowedMimeTypes`, `inlineMaxTokens` (30 000), `readPageChars` (20 000), `retentionDays` (30), `vision`, `attachNewUploads`, `maxImages`, `maxImageBytes`, `carryRecentImages`, `extractText(file, bytes)`, `extractCacheBytes`, `purgeIntervalMs`. An agent that takes no files answers uploads with `403 attachments_disabled`, a type outside `allowedMimeTypes` is `415 unsupported_file_type`, a full conversation `409 too_many_files`.
- **Raw-body upload**: `POST /files?name=&conversationId=` takes the file's bytes with its own `Content-Type` (`&mimeType=` overrides); the JSON base64 form keeps working. The Node, Express, Fastify (buffer content-type parsers in the plugin's own scope) and Next.js adapters hand the route the bytes; `server.maxUploadBytes()` sizes the Node adapter's default body limit. `isRawUploadRequest` is exported for custom adapters.
- **Ownership**: `FileRecord.userId` / `agentId` / `expiresAt`. `GET` / `DELETE` / `/content` of a file answer 404 to anyone but its uploader (and to anyone who cannot open its conversation); a message attaches only files of its own conversation that the caller uploaded.
- **Inline files are stored**: `SendMessageRequest.files` are saved (in the conversation, owned by the sender, under the upload limits) before the turn, so the message carries real ids (they used to be throwaway ids that 404ed). `fileIds` and `files` are checked against the agent's settings before the turn starts, streamed or not.
- **What the agent is given.** A user message that carries files is built, on every turn, as the person's text plus an attachment block that names every attachment by kind: documents inline (`<document name id>`) up to `inlineMaxTokens`, otherwise a note listing them so an agent-sdk agent reads them with `session_files_list` / `session_files_read({ fileId, page })` (`createSessionFileTools()`); an agent without those tools (or a Chat Completions / Responses agent) gets the start of the documents and a `file_truncated` warning. Unreadable and expired files are named, never fatal. Warnings (`file_truncated`, `file_unreadable`, `images_not_supported`) are on the response, `stream.done` and the assistant message (`metadata.warnings`). Content arrays are passed to the model as parts, no longer JSON-stringified.
- **Images by reference** (`vision`): an image is `session-file://<id>` in the agent's input, preceded by a text handle (`[Attached image: "name" (id ...)]`), and read from storage where the model is called - `withSessionImages(model)` for an agent-sdk model (an `image_url` part with a `data:` URL, the one form both SDK adapters read; `format: 'sdk-base64'` for agent-sdk's typed `{ base64, media_type }`), the server itself for an unwrapped one (pictures are put back to references before a paused state is stored) and for Chat Completions (`image_url` data URLs) and Responses (`input_image`). The newest `maxImages` / `maxImageBytes` are shown, older ones named; the last `carryRecentImages` earlier image messages keep their images; `createSessionFileTools({ viewImage: true })` adds `session_files_view_image`; `createImageAwareTokenCounter()` keeps the SDK from counting base64 as text.
- **Handlers**: `ProcessMessageParams` / `ResolveActionParams` get `getFileContent(id)` and `getFileText(id)`, scoped to the conversation.
- **Reading PDF and Office files**: `@cognipeer/to-markdown` as an optional peer; the default extractor reads text-like files, a hook (`files.extractText`) takes over.
- **Retention**: files get `expiresAt = upload + retentionDays`; the recovery sweep deletes expired files (record and content) - at the first request and every `runs.sweepIntervalMs`, at most once per `files.purgeIntervalMs` (1 hour) - one node at a time with storage leases; `server.purgeExpiredFiles()` does it on demand.
- `GET /conversations/:id/files` (`{ files, total, limit, offset, hasMore, maxFiles }`).
- **`AgentInfo.capabilities.attachments`** (`{ enabled, maxFiles, maxFileSize, allowedMimeTypes, acceptsImages }`) from the settings of each agent, and the keys the first chat-ui read (`metadata.enableFileUpload`, `maxFileSize`, `maxFiles`, `allowedFileTypes`, `acceptsImages`), set when the host has not.
- **Storage**: `SaveFileParams` / `FileRecord` gain `userId`, `agentId`, `expiresAt`; optional `StorageProvider.listFiles({ conversationId, limit, offset, order })` and `purgeExpiredFiles({ before, limit })` (`capabilities().fileIndex`, `BaseStorageProvider._listFiles` / `_purgeExpiredFiles`) on memory, SQLite, MongoDB and PostgreSQL, all passing the provider contract suite. SQLite and PostgreSQL schema version 4 (`files.user_id`, `agent_id`, `expires_at`, PostgreSQL `seq`, and their indexes); MongoDB indexes `(conversationId, createdAt, seq)` and `expiresAt`. A provider without the index still stores and serves files, but the per-conversation limit, `attachNewUploads` and the retention sweep do nothing.
- Exports: `createSessionFileTools`, `withSessionImages`, `createImageAwareTokenCounter`, `isSessionImageModel`, `FILES_DEFAULTS`, the tool-name constants, `FilesConfig`, `AgentFilesConfig`, `AttachmentsCapability`, `ExtractTextFile`, `ListFilesResponse`, `ListFilesParams`, `PurgeExpiredFilesParams`, `AgentRegistrationOptions`. OpenAPI: the new route and fields, the raw upload, `fileIds`.

- **Approvals, completely** ([guide](docs/guide/human-in-the-loop.md)).
  - *Answers do not lose each other.* Conversations carry a `version` and `StorageProvider.updateConversationIf(id, ifVersion, params)` updates only if nobody else did first (`null` otherwise); every built-in provider has it (`capabilities().atomicUpdate`).
    The decision of an answer is applied to the stored state with it, so the several actions of one pause can be answered at the same time - from one client, two tabs or two server instances - and every decision is kept; exactly one answer, the one that closes the pause, carries the turn on. An answer that meets another answer being recorded now waits for it (`hitl.resolveWaitMs`, 3 s) instead of failing with `409 conversation_busy`. Turn bookkeeping (the pause, remembered tools, spend) and a budget change use the same compare-and-set, so a turn and a `PATCH` cannot overwrite each other.
  - *Requests lapse.* Every pending action gets `expiresAt` - the agent's own, else now + `hitl.timeoutMinutes` (server option or `AgentRegistration.hitl` / the `hitl` registration option; default 1440, `0` never). After it the action answers `410 action_expired`, and the recovery sweep (every `runs.sweepIntervalMs`, at the first request, or `await server.expirePendingActions({ conversationId? })`) applies `hitl.onTimeout`: `"deny"` (default) answers a lapsed approval as a refusal and a question as skipped (`system:timeout`) and, once nothing is open, lets the agent carry on as a run of its own (`session.status_running` with `trigger: "timeout"`); `"cancel"` drops the pause and ends the turn `cancelled`. The policy is the one the pause was taken with. Conversations record the earliest deadline (`Conversation.actionDueAt`, storage only) and `getConversations({ actionDueBefore })` finds the due ones (`capabilities().actionDeadlines`).
  - *Who may answer.* `hitl.authorizeResolve(ctx, { conversation, action })` decides for everyone (default: the conversation's owner); `403 action_forbidden`. Checked after 404 / 409 / 410.
  - *A durable record.* The assistant message that asked keeps `metadata.pendingActions`: each action as it was asked plus `status` (`pending`, `resolved`, `cancelled`, `expired`), `resolution`, `resolvedBy` and `resolvedAt`, written with the new optional `StorageProvider.updateMessage(id, { content?, metadata? })` (all built-in providers); `requiresAction` goes once nothing on the message is open. `pendingActionPolicy: "cancel"` and `POST .../cancel` record the cancelled actions there too.
  - *Edited arguments are checked.* `approvedArgs` are validated against the tool's zod schema or JSON Schema (`agent.__runtime.tools`): `400 invalid_approved_args`; `hitl.validateApprovedArgs: false` turns it off.
  - *Remembered tools are visible.* A call approved on a remembered tool is an `action.resolved` event (`resolved_by: "remembered"`, `remembered: true`); `GET /conversations/:id/remembered-tools`, `conversation.rememberedTools` and `DELETE /conversations/:id/remembered-tools/:tool` list and revoke them.
  - Question options keep their `preview`, approvals their `summary` (`metadata.summary` of the agent-sdk entry); `action.resolved` events say `expired`, `remembered` and `edited_args` when they apply.
- **Usage & budgets** ([guide](docs/guide/budgets.md)). `usage` is normalised from agent-sdk's real ledger (`{ perRequest, totals }`, cumulative): a run reports only what it used itself, so a turn resumed after an approval no longer reports the calls before the pause again, and `cachedInputTokens` / `costUsd` appear when known. The flat usage of Chat Completions, Responses and custom handlers is kept (a handler can add `costUsd` or `model`).
  The `pricing(model)` option (server, or per agent) prices the tokens; `conversation.spentUsd` and `spentUsd` on responses count every priced turn, cancelled ones too. `budget: { maxCostUsd, onReach: "pause" | "stop" }` (server option, `AgentRegistration.budget`, `budget` on `POST /conversations`, `PATCH /conversations/:id`) limits a conversation: a used-up budget refuses messages with `402 budget_reached`; agent-sdk is given the room that is left as `limits.maxCostUsd` (use `costEstimatorFromPricing(pricing)` as its `costEstimator`) so a turn stops in the middle; the turn that reaches it ends `stopReason: "budget_reached"` with a `budget.reached` event, and with `onReach: "pause"` the conversation is `runtime.status: "budget_paused"` and the stopped agent-sdk state is kept. Lowering a budget is the owner's, raising or removing it needs the `authorizeBudget` hook (`403 budget_forbidden`); `POST /conversations/:id/continue` carries the stopped turn on after a raise. `session.usage` events carry `turn_cost_usd`, `spent_usd` and `budget`; `stream.done` and the responses carry `budget` and `spentUsd`.
- **Storage**: optional `updateConversationIf` / `Conversation.version`, `updateMessage`, `UpdateConversationParams.actionDueAt` and `GetConversationsParams.actionDueBefore` on memory, SQLite, MongoDB and PostgreSQL, all passing the provider contract suite (a new `compare-and-set`, `action deadlines` and `updating a message` section). SQLite and PostgreSQL schema version 5 (`conversations.version`, `conversations.action_due_at` and its partial index); MongoDB gets the partial index `actionDueAt`.
- Exports: `costEstimatorFromPricing`, `HitlConfig`, `AgentHitlConfig`, `SessionBudget`, `ModelPricing`, `PricingFn`, `BudgetChange`, `UsageInfo`, `ActionSnapshot`, `ActionStatus`, `UpdateMessageParams`, `UpdateConversationRequest`, `ContinueConversationRequest`, `RememberedToolsResponse`. OpenAPI: the new routes, fields and error codes.

- **Host-backed agents** ([guide](docs/guide/host-agents.md)): `server.registerHostAgent({ info, invoke, resolveAction?, cancel? })` serves an agent whose work runs in the host's own backend as a first-class agent - no agent-sdk look-alike, no fabricated pause state, nothing written into the server's own state keys.
  `invoke(input, { emit, signal, files })` reports progress with typed events (`text`, `tool_use`, `tool_result`, `action_required`, `usage`, `stop`) that become the same stored events and `stream.*` frames an agent-sdk agent produces, and returns a typed result (`content`, `status`, `stopReason`, `pendingActions`, `usage`, `files`, `metadata`);
  the server stores the messages, the pending actions, the events and the runtime status itself. `resolveAction(input, io)` is called once per answered action with the whole answer (`decision`, `approvedArgs`, `rememberForSession`, a question's `answers`), the actions still open, and who answered (`system:timeout` for a request that lapsed under `hitl.onTimeout: "deny"`).
  `io.signal` is aborted when the run is cancelled (an agent that ignores it is abandoned after `runs.cancelGraceMs`); the optional `cancel(input)` hook hears about a cancelled run and about open requests that were withdrawn, lapsed or deleted with their conversation. `io.files` reads the conversation's files only (`list`, `read`, `text`).
  A result the server cannot use is a `500 invalid_host_result` (nothing half-made is stored); a malformed event is ignored with one warning per turn. `hostAgentRegistration(definition)` builds the registration for hosts that resolve their agents per request (`config.agents`); `AgentRegistration.host`, and the types `HostAgent`, `HostAgentDefinition`, `HostEvent`, `HostFiles`, `HostRunIo`, `HostInvokeInput`, `HostResolveInput`, `HostCancelInput`, `HostCancelReason`, `HostTurnResult`, are exported. Old registrations are unchanged.
- **`allowAnonymousList`** (default `false`): `GET /conversations` and `GET /tasks` answer one user's records, and a request that names no user - no token user, no `context.user`, no `resolveUserId` result, no trusted `?userId=` - is refused with `401 identity_required` instead of listing everyone's. See Changed.
- **`server.getRoutes()`**: every route as `{ method, path }`, for tooling. The OpenAPI document now lists every route and the machine-readable `error.code`s of the `Error` schema (`ERROR_CODES`); `test/docs.test.ts` holds the routes, the spec, the error codes, the server options and the documentation to each other.
- **`examples/standalone`**: a runnable server (SQLite or MongoDB, an agent-sdk agent with approvals, questions, files and cancel, a host-backed agent, CORS, Swagger) with a scripted model, so it needs no API key; `test/example.test.ts` runs it over HTTP on both databases.

### Changed

- **Listing needs a user.** `GET /conversations` and `GET /tasks` used to return every user's records to a request that named nobody (single reads were already refused). They now answer `401 identity_required` unless the server sets `allowAnonymousList: true` - a server that has no sign-in (a local tool, a demo) sets it. A request that names a user (a token, `resolveContext` with a `user`, `resolveUserId`, or without `resolveContext` a `?userId=`) is unaffected.
- `FileRecord.mimeType` is stored without parameters (`text/plain; charset=utf-8` becomes `text/plain`), and `application/octet-stream` (or a value that is not a MIME type) is guessed from the extension.
- A file can only be attached to a message of the conversation it was uploaded to, by the person who uploaded it. A file uploaded without `conversationId` is stored but cannot be attached (it used to be attachable to any conversation).
- `GET /files/:id/content` sanitises the file name and type before they reach a header and adds `X-Content-Type-Options: nosniff` and `Cache-Control: private, no-store`; `?disposition=inline` shows a picture, PDF or plain text in place (the default is still a download).
- A task's input `files` are checked against the agent's settings and kept in the conversation the task runs in, which is created with the task when it has files (`task.conversationId` is set from the start); they used to be stored without owner or conversation.
- Files now expire: `files.retentionDays` defaults to 30. Set it to `0` to keep files for good, as before. Files uploaded before this version have no expiry.
- `limits.maxFiles` is the number of files one message attaches; the number a conversation may hold is `files.maxFiles`.
- The Node handler's default body limit follows the largest file any agent accepts (`server.maxUploadBytes()`); the Fastify plugin adds buffer content-type parsers (for `text/plain` and types Fastify has none for) in its own scope.
- **`GET /conversations/:id` returns the newest page of messages** (100 by default, oldest first within the page) instead of the first 100. Conversations of up to 100 messages are unchanged.
- **A disconnect no longer cancels the turn.** Before, a streamed turn lived inside its HTTP stream and was dropped when the client went away; now it runs to its end (see Detached runs). Clients that relied on a disconnect to stop a turn call `POST /conversations/:id/cancel`.
- A message or answer to a conversation that is already running a turn is `409 conversation_busy` (it used to start a second, overlapping turn, or `409 action_not_pending` for a duplicate answer). The in-process `resolvingActions` guard is replaced by the conversation lease.
- A non-streamed request to an SDK agent now passes `onEvent` and `cancellationToken` to `invoke` (tool calls and results go to the event log whether or not the request streams); `onStream` and `stream: true` still only for `stream: true`.
- `ProcessMessageParams.conversationId` of a task is now the id of the task's own conversation (it was `task_<id>`).
- Assistant messages always carry `metadata.status` and `metadata.stopReason`; an assistant message that stopped before it said anything (cancelled / incomplete, no text) is left out of the history the agent is given.
- SQLite and PostgreSQL schema version 3 (the `events`, `event_streams` and `leases` tables and `tasks.conversation_id`); MongoDB adds the `events`, `event_streams` and `leases` collections. Upgrades run once on connect.
- Work that belongs to no request (recovery, pruning) calls the storage provider with the context `{ data: { system: true } }`.
- An action's `expiresAt` is no longer only passed through: after it the action answers `410 action_expired` and `hitl.onTimeout` applies (default `deny`: the agent is told the tool was refused and carries on). Set `hitl.timeoutMinutes: 0` to keep requests open for ever, as before.
- A handler's `state` is stored with the rest of the turn (it used to be written in the middle of it) and can no longer erase the server's own bookkeeping (pause state, remembered tools, spend); `lastResponseId` of a Responses API agent is written the same way.
- `usage` of an agent-sdk agent is the usage of the run, from the SDK's ledger (it used to be the raw ledger, or empty). Responses may carry `cachedInputTokens` and `costUsd`.
- Creating and updating a conversation answers without the storage-only `version` / `actionDueAt`.
- The expiry sweep calls `getConversations` with `actionDueBefore`; a storage wrapper that fails or logs `getConversations` calls will see it.
- Rows created in the same millisecond keep their insertion order in every provider (conversations, messages and tasks), and a new message bumps its conversation's `updatedAt` in every provider (it already did in memory).
- Every provider reads records back the same way: `undefined` and `Date`s in JSON fields are normalised as `JSON.parse(JSON.stringify())` would, `files: []` reads as no files, absent `userId` / `title` read as `undefined`, task `comments` is always an array with `Date`s, and returned records are copies.
- Deleting a conversation deletes its files and their content in every provider (SQLite, PostgreSQL and MongoDB used to keep them); deleting a message keeps its files (memory used to delete them).
- Saving a file is all-or-nothing: no orphaned content when the record is refused. A file for a conversation or message that does not exist is a 404 in every provider (it was a 500 on SQL, accepted on memory / MongoDB), and `createMessage` for an unknown conversation is a 404 (MongoDB used to accept it).
- A task has one result: `createTaskResult` replaces the existing one in every provider (it used to overwrite in memory, return an arbitrary row on SQL and fail with a duplicate-key error on MongoDB, which marked a finished `waiting_for_input` task failed).
- PostgreSQL: the migration adds `tasks.comments`, per-table `seq` columns, and prefix-qualified index names (old unprefixed ones are dropped when they belong to this prefix's tables); `created_at` / `updated_at` are written by the app clock in every provider; an idle-client error no longer crashes the process.
- MongoDB: the client connects with `ignoreUndefined` and `promoteBuffers`; indexes cover the sort keys (older single-field indexes they replace are dropped).
- `POST /files` checks the size from the base64 length before decoding the content.
- `POST /files` answers an empty file (empty content, or base64 that decodes to nothing) with `400 VALIDATION_ERROR` and the message `File is empty`, instead of the generic "file.name, file.content, and file.mimeType are required".
- The Fastify adapter answers a body over Fastify's limit with `413 { error: { code: "PAYLOAD_TOO_LARGE", message } }` (the Node handler's envelope, CORS headers included) instead of Fastify's own `FST_ERR_CTP_BODY_TOO_LARGE` shape. Other Fastify errors still reach the app's error handler.

### Fixed

- **MongoDB** returned file content as a BSON `Binary` (downloads and any code reading bytes broke), failed uploads over 16 MiB with a generic 500, stored left-out fields as `null` (pending actions came back with `title: null, args: null`), dropped task comments, failed an update that changed nothing with "Task not found", and failed a second task result with a duplicate-key error.
- **PostgreSQL** returned message text that is valid JSON as a number, boolean, object or `null` (`"42"` came back as `42`), refused NUL characters with a 500, dropped task comments, and answered an over-long title or name with a 500.
- **History**: the agent and `GET /conversations/:id` saw only the first 100 messages of a conversation, so after about 50 turns the model never received the newest message. The agent now gets the whole conversation.
- Pending actions and conversation state kept `undefined` values in memory and `null` in MongoDB; every provider now stores the same JSON.
- **Documentation** brought in line with the code: the file guide, the storage guides and API reference (`createInMemoryProvider`, `getConversations` / `PaginatedResult`, SQLite, the real tables and indexes), the getting-started and framework guides (no more `createMemoryProvider`), core concepts and architecture, the SSE examples (plain `data:` frames, `stream: true`), the error shape (`{ error: { code, message, details } }`), the task routes (comments were undocumented), the authentication guides (`validateToken`, the options the JWT provider has) and the human-in-the-loop caveats about restarts and several instances. `fileStorage` is documented as not used yet.

## [0.2.0] - 2026-10-09

All changes are additive; existing configurations keep working unchanged.

### Added

- **Request context**: `config.resolveContext(req)` returns a `RequestContext` (`user` + arbitrary `data`) or `null` (-> 401). The context is passed to dynamic agent resolvers, custom `AgentHandler`s (`params.context`), SDK agents (`invoke(params, { context })`), `auth.resolveUserId`, and every storage call. It is also readable anywhere inside a request through `getRequestContext()` (AsyncLocalStorage). With `resolveContext` set, the resolved identity is authoritative: client-supplied `userId` (body/query) is ignored and conversations/tasks owned by someone else are not accessible.
- **Dynamic agents**: `config.agents` accepts an array or a `(ctx) => AgentRegistration[]` function resolved per request. List, get, create-conversation, send (also streaming) and tasks use it; an agent that is not served to the request answers 404. New `server.getAgentsFor(ctx)` / `getAgentFor(id, ctx)`.
- **Node handler**: `createNodeHandler(server, { basePath })` (also `@cognipeer/agent-server/node`) serves the API on raw `IncomingMessage`/`ServerResponse` - JSON bodies with size limit, token auth, `resolveContext`, CORS, SSE with backpressure and client-disconnect handling.
- **Fastify adapter**: `@cognipeer/agent-server/fastify` (`createFastifyPlugin`, `mountOnFastify`) mounts the server under a possibly parameterised prefix (`/api/portal/:portalKey`; params reach `resolveContext` as `req.mountParams`), reuses Fastify's already-parsed JSON body and carries hook-set headers over to the hijacked response. `fastify` is an optional peer dependency.
- **Storage context**: all `StorageProvider` methods (and `BaseStorageProvider`'s `_`-hooks) take an optional trailing `ctx?: RequestContext` so external stores can scope by tenant/user. Built-in providers ignore it.
- `server.handleRoute(method, routePath, ctx)` for adapters that mount under a dynamic prefix; `RouteContext` gained `headers`, `url`, `mountParams`, `raw`, `context`. Express and Next adapters now forward headers/url/native request.
- Docs: `guide/request-context`, rewritten `guide/custom-storage`, adapter docs.
- **`maskServerErrors`** (default false): hides the message of every error that does not carry an explicit 4xx `statusCode` (or `expose: true`) - in HTTP bodies and in the SSE `stream.error` event - and logs the original. For deployments whose audience is not the operator. Host-authored 4xx errors keep their message and (in the stream) their own `code`.

### Fixed

- **Trusted identity is fail-closed**: with `resolveContext`, a conversation or task that carries no `userId` is refused (403) instead of being open to every authenticated caller. (Single reads only: the lists answered everyone's records to a request without a user until 0.3.0, see `allowAnonymousList`.)
- **Paging**: `limit` is capped at 200 and a negative or non-numeric `offset` becomes 0 before reaching the storage provider (list conversations, messages, tasks).
- **Empty answer bubble**: when an SDK agent returned its answer without streaming any text (tool agents running non-streaming), the SSE stream ended with `stream.done` only. The final content is now emitted once as `stream.text` (`isFinal: true`) before `stream.done`; the SDK's `isFinal` chunk is used when the result carries no content.
- **Streaming SDK agent that throws**: a rejected `invoke` used to leave the SSE stream waiting forever and surface as an `unhandledRejection` (which terminates a host process). It now ends the stream with a `stream.error` event (text already sent stays sent; no assistant message is stored).
- **Fastify apps with a raw JSON parser**: an app that registers its own `application/json` parser which keeps the body as a string or Buffer used to hand the routes that string ("agentId is required"). The Node/Fastify adapters now decode a provided string/Buffer body like one read from the stream (invalid JSON -> 400).
- **CommonJS consumers**: every `exports` entry now has a `default` condition next to `import`, so `require('@cognipeer/agent-server')` (e.g. TypeScript compiled to CJS by `tsx`/ts-node) no longer fails with `ERR_PACKAGE_PATH_NOT_EXPORTED`. The package is still ESM-only: `require()` needs Node >= 20.19 or >= 22.12 (`require(esm)`).
- Errors thrown as plain `{ statusCode, code, message }` objects (404 conversation/agent not found, 400 validation, 403 forbidden) were answered with a generic 500; they now keep their status. Only 5xx errors are logged.

## [0.1.6] - 2026-08-28

### Added

- Added Node 24 CI and npm Trusted Publishing release workflows.
- Added an entrypoint smoke test for server and in-memory storage construction.

## [0.1.5] - 2026-03-24

### Fixed

- Prevented duplication of the final text chunk in Agent SDK streams
- Made the `onEvent` handler phase-aware to stop duplicate SSE `tool_call` events: `start` now emits `stream.tool_call`, `success`/`error` emit `stream.tool_result`, and `skipped` (tool limit reached) is suppressed — previously every tool call produced two `stream.tool_call` events, causing duplicate rendering in the chat UI

## [0.1.4] - 2026-03-06

### Added

- Chat Completions and Responses API providers for OpenAI-compatible endpoints and multi-turn conversations with built-in tools
- SQLite storage provider (via `better-sqlite3`), with migration logic for conversations, messages, files, tasks, and task results
- Automatic conversation title generation using LLM configuration

## [0.1.3] - 2026-02-25

### Fixed

- Ensured message content is always stringified in `PostgresStorageProvider`

### Changed

- Enabled code splitting in the `tsup` build configuration

## [0.1.2] - 2026-02-25

No distinct changes — published the same day as 0.1.0, 0.1.1, and 0.1.3 during the initial release's rapid-iteration burst. Git history jumps directly from the 0.1.1 to the 0.1.3 version bump, so no separate 0.1.2 commits could be identified; the fix and build change above are the actual delta.

## [0.1.1] - 2026-02-25

### Added

- Full Task system: types, storage-provider implementations (in-memory, MongoDB, PostgreSQL), API endpoints, execution logic, and Swagger/OpenAPI documentation
- Task comments feature with dedicated API endpoints and Swagger documentation
- Comprehensive Task system documentation

### Changed

- Preserved tool-call information in message structure — SDK agent invocation now includes optional `tool_calls`, `tool_call_id`, and `name` fields, correctly mapped from prior messages
- Refactored event handling to use a shared helper for extracting tool event properties, with improved error logging
- Translated README to English and clarified installation instructions
- Added repository, homepage, and bugs metadata to `package.json`

### Fixed

- Fixed a syntax error in the base storage provider
- Fixed callback status consistency (`completed` instead of `complete`)

## [0.1.0] - 2025-01-01

### Added

- Initial release
- `createAgentServer` factory function
- Express adapter with `createExpressMiddleware`
- Next.js adapter with `createNextRouteHandlers`
- PostgreSQL storage provider
- MongoDB storage provider
- In-memory storage provider
- Token-based authentication
- JWT authentication
- SSE streaming support
- File upload/download support
- Swagger UI integration
- OpenAPI spec generation
- SDK agent registration
- Custom agent handler support
