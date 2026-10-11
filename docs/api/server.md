# Server API

The main `AgentServer` class and factory function.

## createAgentServer

Creates a new agent server instance.

```typescript
import { createAgentServer } from '@cognipeer/agent-server';

const agentServer = createAgentServer(config);
```

### Parameters

#### config

```typescript
interface AgentServerConfig {
  // Base path for all routes (e.g., '/api/agents')
  basePath: string;

  // Storage provider for persistence
  storage: StorageProvider;

  // Per-request context (user + data); null -> 401. See guide/request-context
  resolveContext?: (req: ContextRequest) => Promise<RequestContext | null> | RequestContext | null;

  // Agents: array, or resolved per request
  agents?: AgentRegistration[] | ((ctx: RequestContext) => AgentRegistration[] | Promise<AgentRegistration[]>);

  // Generate a conversation title after the first exchange: an OpenAI-compatible endpoint, or your own `generate` function
  titleGeneration?: TitleGenerationConfig;

  // Reserved for a separate file store; files are kept by the storage provider and this is not used
  fileStorage?: FileStorageProvider;

  // Swagger UI configuration
  swagger?: {
    enabled: boolean;
    path?: string;        // Default: '/docs'
    title?: string;
    version?: string;
    description?: string;
  };

  // Authentication configuration
  auth?: {
    enabled: boolean;
    provider?: AuthProvider;
    headerName?: string;  // Default: 'Authorization'
    tokenPrefix?: string; // Default: 'Bearer '
    excludeRoutes?: string[];
    resolveUserId?: (ctx: { headers?, query?, body?, context? }) => string | undefined | Promise<string | undefined>;
  };

  // CORS configuration
  cors?: {
    enabled: boolean;
    origins?: string[];
    methods?: string[];
    headers?: string[];
  };

  // Request limits (file size, page sizes, the largest state a pause may store)
  limits?: RequestLimits;

  // Only errors the host authored (4xx, or `expose: true`) show their text; the rest says "An unexpected error occurred"
  maskServerErrors?: boolean;

  // What a message does while the conversation waits on an approval: 'reject' (409, default) or 'cancel'
  pendingActionPolicy?: 'reject' | 'cancel';

  // Honour `rememberForSession` on tool approvals (default true)
  allowRememberApproval?: boolean;

  // Who may list: a request that names no user is refused (401 identity_required) unless this is true
  allowAnonymousList?: boolean;

  // Leases, cancellation, the event stream and recovery - see guide/runs
  runs?: RunsConfig;

  // Attachments: limits, how agents read them, images, retention - see guide/file-management
  files?: FilesConfig;

  // Approvals and questions: timeouts, who may answer, edited arguments - see guide/human-in-the-loop
  hitl?: HitlConfig;

  // Spend: what a token costs, the limit new conversations start with, who may raise it - see guide/budgets
  pricing?: (model: string) => ModelPricing | undefined;
  budget?: { maxCostUsd: number; onReach: 'pause' | 'stop' };
  authorizeBudget?: (ctx: RequestContext, change: BudgetChange) => boolean | Promise<boolean>;

  // What a chat client shows around every agent: welcome, starters, message actions, history, feedback, export - see guide/chat-experience
  experience?: AgentExperience;
  // Ratings on answers: reason codes, comment length, a hook that hears every rating
  feedback?: FeedbackConfig;
  // Downloading a conversation: allowed or not, tool calls, labels, a PDF renderer
  export?: ExportConfig;

  // Asked before work that costs something; refuse with 429 rate_limited - see guide/embedding
  rateLimit?: (ctx: RequestContext, request: RateLimitRequest) => RateLimitDecision | Promise<RateLimitDecision>;
  // Told about exports, deletions, regenerations, edits, pins and ratings
  audit?: (ctx: RequestContext, entry: AuditEntry) => void | Promise<void>;
}
```

`allowAnonymousList` (default `false`): `GET /conversations` and `GET /tasks` answer only for a request that **names a user** - a token user, `context.user` from
`resolveContext`, a `resolveUserId` result, or (without `resolveContext`) a `userId` query parameter. A request that names nobody would list the conversations of everyone, so it is
refused with `401 identity_required`. Set the option on a server that is single-user by design (a local tool, a demo). The built-in storage providers keep every user's data in one namespace and
do not separate tenants: a multi-tenant host resolves a user for each request, see [Request Context](../guide/request-context#who-may-list).

`maskServerErrors` keeps internal error text away from the client; use it whenever the audience is not the operator (see [Error Handling](../guide/error-handling)).
`allowRememberApproval: false` always asks again, whatever the person ticked ("don't ask again", see [Approvals & Questions](../guide/human-in-the-loop#remembered-tools)).
`titleGeneration` asks for a short title after the first answer: an OpenAI-compatible endpoint (`baseUrl` + `model`, `path` defaults to `/v1/chat/completions`), or - for a host that has its own model access, accounting and limits - a
`generate(input)` function. The title has at most `maxWords` words (default 6), is written in the language of the conversation, and is made from the first message and the first answer (`includeAnswer: false` leaves the answer out). A failure leaves the conversation untitled.
The turn holds its conversation while it waits, so the call is bounded: `timeoutMs` (default 10 000) cuts it short, and cancelling the turn ends it at once; a title that did not arrive in time is skipped. What making the title used is reported on a `session.title` event
(`purpose: "title"`), so the host can count it to the person. An agent has its own `titleGeneration` (or `false`). See [Chat experience](../guide/chat-experience#generated-titles).

`experience`, `feedback` and `export` shape the chat around the agents - see [Chat experience](../guide/chat-experience): `experience` is the welcome text, the starters and the switches of message actions, history management, feedback and export (an agent overrides fields with its own `experience`);
`feedback` has `enabled`, `reasons`, `maxCommentLength` and the `onFeedback(ctx, event)` hook; `export` has `enabled`, `includeTools`, `maxMessages`, `labels` and `renderPdf`.
`rateLimit` and `audit` are the host's two hooks for limits and an audit trail - see [Embedding & limits](../guide/embedding#limits).

`HitlConfig` (every field optional; an agent overrides `timeoutMinutes`, `onTimeout` and `validateApprovedArgs`, see [Approvals & Questions](../guide/human-in-the-loop)):

| Field | Default | |
| --- | --- | --- |
| `timeoutMinutes` | 1440 | Minutes a request waits for an answer; `0`: never. A request that comes with its own `expiresAt` keeps it |
| `onTimeout` | `'deny'` | A request nobody answered in time: answered as a refusal and the agent carries on, or (`'cancel'`) dropped and the turn ends |
| `authorizeResolve(ctx, { conversation, action })` | the conversation's owner | Decides who may answer; `false` is `403 action_forbidden` |
| `validateApprovedArgs` | `true` | Check edited arguments against the tool's schema (`400 invalid_approved_args`) |
| `resolveWaitMs` | 3000 | How long an answer waits for another answer to the same conversation instead of `409 conversation_busy` |
| `clientToolMaxOutputBytes` | 65 536 | Largest `output` of a [client tool](../guide/human-in-the-loop#client-tools) answer (`400 invalid_client_tool_result`) |

`FilesConfig` (every field optional; an agent overrides each but `extractCacheBytes` and `purgeIntervalMs`, see [Files](../guide/file-management#settings)):

| Field | Default | |
| --- | --- | --- |
| `enabled` | `true` | `false` on an agent refuses uploads to it (`403 attachments_disabled`) |
| `maxFiles` | 10 | Files one conversation may hold |
| `maxFileSize` | `limits.maxFileSize`, else 10 MiB | Bytes, capped by the storage provider |
| `allowedMimeTypes` | any | Types and `image/*` wildcards |
| `inlineMaxTokens` | 30 000 | Up to this the documents of a message go into it; over it they are read in pages |
| `readPageChars` | 20 000 | Page size of `session_files_read` |
| `retentionDays` | 30 | `0` keeps files for good |
| `vision` | `false` | The agent's model looks at images |
| `attachNewUploads` | `false` | Uploads no message carried yet ride along with the next one |
| `maxImages` / `maxImageBytes` | 6 / 12 000 000 | What one model request carries |
| `carryRecentImages` | 2 | Earlier image messages that keep showing their images |
| `extractText(file, bytes)` | | Turns a file into text: the text, `undefined` for the default, `null` for none |
| `extractCacheBytes` | 32 MiB | Extracted text kept in memory (server only) |
| `purgeIntervalMs` | 3 600 000 | How often expired files are deleted; 0 turns it off (server only) |

`RunsConfig` (every field optional):

| Field | Default | |
| --- | --- | --- |
| `nodeId` | random per process | Names this instance in leases |
| `leaseTtlMs` | 60 000 | A crashed server frees its conversations after this long |
| `cancelGraceMs` | 5 000 | How long a cancelled run may take to wind down before it is abandoned |
| `cancelWaitMs` | 5 000 | How long `POST .../cancel` waits before answering 202 |
| `pingIntervalMs` | 15 000 | `: ping` on the event stream |
| `followPollMs` | 1 000 | How often a follower looks for events written by another node |
| `maxStreamMs` | 3 600 000 | Longest an event stream stays open |
| `eventPageSize` / `maxEventPageSize` | 100 / 1 000 | `GET .../events` default and largest `limit` |
| `maxEventDataBytes` | 16 384 | Larger event data is cut (`_truncated: true`) |
| `memoryEventLimit` | 2 000 | Events kept per conversation when the provider has no event log |
| `eventRetentionDays` | 30 | Older events are pruned by the sweep; 0 keeps them |
| `sweepIntervalMs` | 60 000 | Period of the recovery sweep; 0 turns it off |
| `recoverOnStart` | `true` | Recover once at the first request |
| `assumeSingleNode` | `true` | Fail tasks left `running` by an earlier process when the provider has no leases |

### Returns

`AgentServer` - The agent server instance.

## AgentServer

The main server class.

### Methods

#### getAgentsFor / getAgentFor / handleRoute

```typescript
await server.getAgentsFor(ctx);       // static + dynamic agent infos for a request context
await server.getAgentFor('id', ctx);  // AgentRegistration | undefined
await server.handleRoute('GET', '/agents', { query: {}, headers, context }); // path relative to the server
```

#### registerSDKAgent

Register an agent created with `@cognipeer/agent-sdk`.

```typescript
agentServer.registerSDKAgent(id, agent, info?, options?);
```

| Parameter | Type | Description |
|-----------|------|-------------|
| id | `string` | Unique agent identifier |
| agent | `SmartAgent` | Agent from agent-sdk |
| info | `Partial<AgentInfo>` | Optional agent metadata |
| options | `{ files?, hitl?, budget?, pricing?, experience?, titleGeneration? }` | Settings of this agent, overriding the server's `files`, `hitl`, `budget` (`null`: none), `pricing`, `experience` and `titleGeneration` (`false`: no generated titles for this agent) (`registerCustomAgent`, `registerChatCompletionsAgent` and `registerResponsesAgent` take the same last argument). A `budget` needs prices: this agent's or the server's |

```typescript
import { createSmartAgent } from '@cognipeer/agent-sdk';

const assistant = createSmartAgent({
  name: 'Assistant',
  model: myModel,
});

agentServer.registerSDKAgent('assistant', assistant, {
  description: 'A helpful assistant',
  version: '1.0.0',
});
```

#### registerCustomAgent

Register a custom agent handler.

```typescript
agentServer.registerCustomAgent(id, handler, info, options?);
```

| Parameter | Type | Description |
|-----------|------|-------------|
| id | `string` | Unique agent identifier |
| handler | `AgentHandler` | Custom handler object |
| info | `Omit<AgentInfo, 'id'>` | Agent metadata (`name` is required) |

```typescript
agentServer.registerCustomAgent('echo', {
  processMessage: async ({ message }) => ({
    content: `Echo: ${message}`,
  }),
}, {
  name: 'Echo Bot',
  description: 'Echoes messages',
});
```

#### registerHostAgent

Register an agent whose work runs in your own backend. It reports progress with typed events and returns a typed result; the server stores the messages, the pending
actions, the events and the runtime status. See [Host-backed agents](../guide/host-agents).

```typescript
agentServer.registerHostAgent({
  info: { id: 'support', name: 'Support' },
  async invoke({ message, history, files, context }, { emit, signal, files: reader }) {
    emit({ type: 'text', text: 'Looking it up... ' });
    return { content: 'Found it.', usage: { inputTokens: 120, outputTokens: 30 } };
  },
  async resolveAction({ action, resolution }, { emit, signal }) { /* optional: continue after an approval or an answer */ return { content: 'Done.' }; },
  async cancel({ reason, runId, actions }) { /* optional: the server lets go of a run or of open requests */ },
});
```

| Field | Type | Description |
|-------|------|-------------|
| `info` | `AgentInfo` | `id` and `name` are required |
| `invoke(input, io)` | `HostInvokeInput, HostRunIo => HostTurnResult` | Runs one user message |
| `resolveAction(input, io)` | `HostResolveInput, HostRunIo => HostTurnResult` | Optional. Called once per answered action; without it the agent's actions answer 404 |
| `cancel(input)` | `HostCancelInput => void` | Optional. A run was cancelled while the agent worked, or open requests were withdrawn / lapsed / deleted |
| `feedback(event)` | `FeedbackEvent => void` | Optional. A person rated (or withdrew the rating of) one of the agent's answers; the rating is already stored on the message |
| `files`, `hitl`, `budget`, `pricing`, `experience`, `titleGeneration` | | The same per-agent settings as the other `register*` methods |

`invoke` also gets `mode` (`"regenerate"` or `"edit"`) and `fromMessageId` when the turn is a [regeneration or an edit-and-resend](../guide/chat-experience#message-actions); the `history` it receives is already cut back.

An agent that is resolved per request (`config.agents`) returns `hostAgentRegistration(definition)` instead - the same definition, as an `AgentRegistration`.
A definition that cannot work (no `info.id`, no `invoke`) throws at registration.

#### registerChatCompletionsAgent / registerResponsesAgent

An OpenAI-compatible Chat Completions or Responses endpoint as an agent (`baseUrl`, `apiKey`, `model`, ...). See [Custom Agents](../guide/custom-agents).

```typescript
agentServer.registerChatCompletionsAgent('gpt', { baseUrl: 'https://api.openai.com', apiKey: process.env.OPENAI_API_KEY!, model: 'gpt-4o' }, { name: 'GPT' });
agentServer.registerResponsesAgent('resp', { baseUrl: 'https://api.openai.com', apiKey: process.env.OPENAI_API_KEY!, model: 'gpt-4o' }, { name: 'Responses' });
```

#### getAgent / getAgents

```typescript
const agent = agentServer.getAgent(id);   // AgentRegistration | undefined - a statically registered agent
const agents = agentServer.getAgents();   // AgentInfo[] - every statically registered agent (use getAgentsFor for a request)
```

#### handleRequest

Process an HTTP request (used by adapters).

```typescript
const result = await agentServer.handleRequest(method, path, context);
```

| Parameter | Type | Description |
|-----------|------|-------------|
| method | `string` | HTTP method |
| path | `string` | Request path, including the base path |
| context | `RouteRequest` | `{ query, body, headers, user, ... }` |

Returns `Promise<RouteResult>`. `handleRoute(method, routePath, request)` is the same for a path that is already relative to the server.

#### getRoutes

```typescript
agentServer.getRoutes(); // [{ method: 'GET', path: '/conversations/:conversationId' }, ...]
```

Every route the server answers, with `:param` placeholders (`:tool*` takes the rest of the path), relative to the base path. For tooling: a gateway's allow-list, a check that your
documentation covers the API.

#### recoverStaleRuns

```typescript
const { conversations, tasks } = await server.recoverStaleRuns();
```

Closes the runs whose server died (`session.error` + `session.status_idle` with `stop_reason: "error"`) and fails the tasks that were left `running`.
It runs by itself at the first request and every `runs.sweepIntervalMs`; call it to run it on demand. See [Runs](../guide/runs#recovery).

#### expirePendingActions

```typescript
const { conversations, expired, denied, continued } = await server.expirePendingActions();
await server.expirePendingActions({ conversationId: 'conv_1' }); // one conversation, also for a store that cannot search for lapsed requests
```

Handles the approvals and questions nobody answered in time (`hitl.onTimeout`): answers them as refusals and lets the agent carry on, or drops the pause. It runs by itself at the first
request and every `runs.sweepIntervalMs`; call it to run it on demand. Resolves when the continuations it started have finished. See [Requests that lapse](../guide/human-in-the-loop#requests-that-lapse).

#### purgeExpiredFiles / maxUploadBytes

```typescript
const deleted = await server.purgeExpiredFiles(); // deletes files past files.retentionDays now (the server also does it every files.purgeIntervalMs)
const bytes = server.maxUploadBytes();            // the largest upload any agent accepts: what an HTTP adapter has to let through
```

#### authenticate

```typescript
const user = await server.authenticate(token); // AuthUser | null (null when token auth is off); throws 401 for a missing or bad token
```

#### close

```typescript
await server.close({ abort: true });
```

Stops the periodic sweep. With `abort: true` it also cancels the running turns and waits for them.

#### getConfig / getBasePath

```typescript
const config = agentServer.getConfig();     // the AgentServerConfig it was created with
const basePath = agentServer.getBasePath(); // without a trailing slash
```

The OpenAPI document is `generateOpenAPISpec(config, agents)` (exported), and it is served at `<basePath>/docs/openapi.json` when `swagger.enabled` is set.

## AgentInfo

Agent metadata interface.

```typescript
interface AgentInfo {
  // Unique identifier
  id: string;

  // Display name
  name: string;

  // Description
  description?: string;

  // Version string
  version?: string;

  // Custom metadata. The server adds `welcome` (Markdown), `starters` and `experience` (the resolved switches) -
  // see guide/chat-experience; what you put there wins over what the server derives
  metadata?: Record<string, unknown>;

  // What the agent can do: pause for approvals / questions, and what it takes as attachments.
  // For an SDK agent the first two are derived from the instance; `attachments` is filled from the `files` settings
  capabilities?: {
    toolApproval?: boolean;
    askUser?: boolean;
    clientTools?: boolean; // pauses for a tool that runs in the page embedding the chat

    attachments?: { enabled?: boolean; maxFiles?: number; maxFileSize?: number; allowedMimeTypes?: string[]; acceptsImages?: boolean };
  };
}
```

## AgentHandler

Custom agent handler interface. It cannot stream: a streamed request gets the whole answer at once. For an agent that streams and reports tool calls, use
a [host-backed agent](../guide/host-agents).

```typescript
interface AgentHandler {
  processMessage(params: ProcessMessageParams): Promise<ProcessMessageResult>;

  // Optional: continue a turn that paused (status 'requires_action'), once per answered action
  resolveAction?(params: ResolveActionParams): Promise<ProcessMessageResult>;
}
```

### ProcessMessageParams

```typescript
interface ProcessMessageParams {
  // Conversation ID
  conversationId: string;

  // What the person typed (the files are not in it)
  message: string;

  // 'regenerate' (the newest answer is asked for again) or 'edit' (a message was changed and re-sent);
  // absent for a new message. fromMessageId is the message the request named
  mode?: 'regenerate' | 'edit';
  fromMessageId?: string;

  // Attached files (stored; every entry has a real id)
  files?: FileAttachment[];

  // Conversation state
  state?: Record<string, unknown>;

  // Request metadata
  metadata?: Record<string, unknown>;

  // Per-request context (user + data from resolveContext)
  context?: RequestContext;

  // Aborted when the run is cancelled (POST /conversations/:id/cancel): stop and return what you have
  signal?: AbortSignal;

  // Read a file of this conversation (null for any other id, or an expired file)
  getFileContent?: (fileId: string) => Promise<Buffer | null>;
  getFileText?: (fileId: string) => Promise<string | null>;
}
```

### ProcessMessageResult

```typescript
interface ProcessMessageResult {
  // Response content
  content: string;

  // Response files
  files?: FileAttachment[];

  // Updated state
  state?: Record<string, unknown>;

  // Response metadata
  metadata?: Record<string, unknown>;

  // Token usage. Add costUsd (what the turn cost), or model (so the server prices the tokens with `pricing`), to take part in budgets
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    cachedInputTokens?: number;
    costUsd?: number;
    model?: string;
  };

  // 'requires_action' + pendingActions to pause the turn (see guide/human-in-the-loop)
  status?: MessageStatus;
  pendingActions?: PendingAction[];

  // Why the turn stopped when it was not simply 'end_turn': 'max_turns' | 'limit' ('budget_reached' is the server's own, see guide/budgets)
  stopReason?: StopReason;
}
```

## HostAgent

The behaviour of a [host-backed agent](../guide/host-agents). Types: [Types](./types#host-backed-agents).

```typescript
interface HostAgent {
  invoke(input: HostInvokeInput, io: HostRunIo): Promise<HostTurnResult> | HostTurnResult;
  resolveAction?(input: HostResolveInput, io: HostRunIo): Promise<HostTurnResult> | HostTurnResult;
  cancel?(input: HostCancelInput): Promise<void> | void;
  feedback?(input: FeedbackEvent): Promise<void> | void;
}

interface HostRunIo {
  emit(event: HostEvent): void; // text | tool_use | tool_result | action_required | usage | stop
  signal: AbortSignal;          // aborted when the run is cancelled
  files: HostFiles;             // list() / read(id) / text(id), scoped to the conversation
}
```

## RouteContext

Request context passed to handlers.

```typescript
interface RouteContext {
  // Authenticated user (from auth provider)
  user?: AuthUser;

  // URL parameters (e.g., { id: '123' })
  params: Record<string, string>;

  // Query parameters
  query: Record<string, string | string[] | undefined>;

  // Request body
  body?: unknown;
}
```

## RouteResult

Handler response object.

```typescript
interface RouteResult<T = unknown> {
  // HTTP status code
  status: number;

  // Response body
  body?: T;

  // Response headers
  headers?: Record<string, string>;

  // Raw buffer (for file downloads)
  raw?: Buffer;

  // SSE stream generator
  stream?: AsyncGenerator<string, void, unknown>;

  // Adapters call it when the client of `stream` goes away, so the stream ends at once.
  // A run the stream was watching is not affected.
  close?: () => void;
}
```

## Example Usage

```typescript
import express from 'express';
import {
  createAgentServer,
  createPostgresProvider,
  createTokenAuthProvider,
  createExpressMiddleware,
} from '@cognipeer/agent-server';
import { createSmartAgent, fromLangchainModel } from '@cognipeer/agent-sdk';
import { ChatOpenAI } from '@langchain/openai';

// Storage
const storage = createPostgresProvider({
  connectionString: process.env.DATABASE_URL,
});

// Auth
const auth = createTokenAuthProvider({
  tokens: { [process.env.API_KEY]: 'admin' },
});

// Server
const agentServer = createAgentServer({
  basePath: '/api/agents',
  storage,
  auth: { enabled: true, provider: auth },
  swagger: { enabled: true },
});

// SDK Agent
const assistant = createSmartAgent({
  name: 'Assistant',
  model: fromLangchainModel(new ChatOpenAI()),
});

agentServer.registerSDKAgent('assistant', assistant);

// Custom Agent
agentServer.registerCustomAgent('echo', {
  processMessage: async ({ message }) => ({
    content: `Echo: ${message}`,
  }),
});

// Express
const app = express();
app.use(express.json());

await storage.connect();
app.use(createExpressMiddleware(agentServer));

app.listen(3000);
```
