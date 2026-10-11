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
    resolveUserId?: (ctx: ResolveContext) => Promise<string | undefined>;
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

  // What a message does while the conversation waits on an approval: 'reject' (409, default) or 'cancel'
  pendingActionPolicy?: 'reject' | 'cancel';

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
}
```

`HitlConfig` (every field optional; an agent overrides `timeoutMinutes`, `onTimeout` and `validateApprovedArgs`, see [Approvals & Questions](../guide/human-in-the-loop)):

| Field | Default | |
| --- | --- | --- |
| `timeoutMinutes` | 1440 | Minutes a request waits for an answer; `0`: never. A request that comes with its own `expiresAt` keeps it |
| `onTimeout` | `'deny'` | A request nobody answered in time: answered as a refusal and the agent carries on, or (`'cancel'`) dropped and the turn ends |
| `authorizeResolve(ctx, { conversation, action })` | the conversation's owner | Decides who may answer; `false` is `403 action_forbidden` |
| `validateApprovedArgs` | `true` | Check edited arguments against the tool's schema (`400 invalid_approved_args`) |
| `resolveWaitMs` | 3000 | How long an answer waits for another answer to the same conversation instead of `409 conversation_busy` |

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
| options | `{ files?, hitl?, budget?, pricing? }` | Settings of this agent, overriding the server's `files`, `hitl`, `budget` (`null`: none) and `pricing` (`registerCustomAgent`, `registerChatCompletionsAgent` and `registerResponsesAgent` take the same last argument). A `budget` needs prices: this agent's or the server's |

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
agentServer.registerCustomAgent(id, handler, info?, options?);
```

| Parameter | Type | Description |
|-----------|------|-------------|
| id | `string` | Unique agent identifier |
| handler | `AgentHandler` | Custom handler object |
| info | `Partial<AgentInfo>` | Optional agent metadata |

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

#### getAgent

Get a registered agent by ID.

```typescript
const agent = agentServer.getAgent(id);
```

Returns `AgentRegistration | undefined`.

#### listAgents

List all registered agents.

```typescript
const agents = agentServer.listAgents();
```

Returns `AgentInfo[]`.

#### handleRequest

Process an HTTP request (used by adapters).

```typescript
const result = await agentServer.handleRequest(method, path, context);
```

| Parameter | Type | Description |
|-----------|------|-------------|
| method | `string` | HTTP method |
| path | `string` | Request path |
| context | `RouteContext` | Request context |

Returns `Promise<RouteResult>`.

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

#### close

```typescript
await server.close({ abort: true });
```

Stops the periodic sweep. With `abort: true` it also cancels the running turns and waits for them.

#### getOpenAPISpec

Get the OpenAPI specification.

```typescript
const spec = agentServer.getOpenAPISpec();
```

Returns the OpenAPI 3.0 specification object.

### Properties

#### storage

Access the storage provider.

```typescript
const storage = agentServer.storage;
```

#### config

Access the server configuration.

```typescript
const config = agentServer.config;
```

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

  // Custom metadata
  metadata?: Record<string, unknown>;
}
```

## AgentHandler

Custom agent handler interface.

```typescript
interface AgentHandler {
  processMessage(params: ProcessMessageParams): Promise<ProcessMessageResult>;
}
```

### ProcessMessageParams

```typescript
interface ProcessMessageParams {
  // Conversation ID
  conversationId: string;

  // User message
  message: string;

  // Attached files
  files?: FileAttachment[];

  // Conversation state
  state?: Record<string, unknown>;

  // Request metadata
  metadata?: Record<string, unknown>;

  // Per-request context (user + data from resolveContext)
  context?: RequestContext;

  // Aborted when the run is cancelled (POST /conversations/:id/cancel): stop and return what you have
  signal?: AbortSignal;
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
