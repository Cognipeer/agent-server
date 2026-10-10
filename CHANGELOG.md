# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.0] - 2026-10-10

Human-in-the-loop: agents can pause for a tool approval or a question, and a client resumes them. All changes are additive; an agent that never pauses behaves exactly as before.

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