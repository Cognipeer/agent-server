# Changelog

All notable changes to `@cognipeer/agent-server`.

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
