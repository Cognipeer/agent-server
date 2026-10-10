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

### Changed

- **`GET /conversations/:id` returns the newest page of messages** (100 by default, oldest first within the page) instead of the first 100. Conversations of up to 100 messages are unchanged.
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

- **Trusted identity is fail-closed**: with `resolveContext`, a conversation or task that carries no `userId` is refused (403) instead of being open to every authenticated caller.
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