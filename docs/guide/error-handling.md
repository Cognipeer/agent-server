# Error Handling

Proper error handling in your agent server application.

## What an error looks like

Every error the server answers is JSON in one shape:

```json
{
  "error": {
    "code": "action_pending",
    "message": "The conversation is waiting for a pending action to be resolved",
    "details": { "pendingActionIds": ["ap1"] }
  }
}
```

`code` is for programs (switch on it), `message` is for people, `details` is optional extra data. A streamed turn that fails sends the same thing as a `stream.error` event
(`{ type: 'stream.error', error: <message>, code }`), and the event log records it as `session.error`.

With `maskServerErrors: true` only errors the host authored for the caller show their text - a 4xx, or an error with `expose: true`. Everything else (a driver error, a bug, any 5xx)
answers `{ code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' }` and the original is logged on the server. Turn it on whenever the audience is not the operator.

## Error Types

The package exports the classes it throws, and treats any object with a `statusCode`, a `code` and a `message` the same way - throw one from a handler to answer with that status.

```typescript
import { AgentServerError, AuthenticationError, AuthorizationError, NotFoundError, ValidationError, StorageLimitError } from '@cognipeer/agent-server';

throw new ValidationError('Rate limit exceeded', { retryAfter: 30 });        // 400 VALIDATION_ERROR
throw new AgentServerError('Quota used up', 'quota_exceeded', 429);          // your own code and status
throw { statusCode: 403, code: 'tenant_suspended', message: 'This tenant is suspended' }; // a plain object works too
```

## Codes

Every `error.code` the server answers with. Besides `400` / `401` / `404`, the ones with a meaning of their own are what a client should handle:

| Status | Code | Meaning |
|--------|------|---------|
| 400 | `VALIDATION_ERROR` | The request is malformed or breaks a limit (details.reason says which, e.g. file_too_large) |
| 400 | `INVALID_REQUEST` | A task comment that is not valid |
| 400 | `model_not_allowed` | The request's `model` is not one of the agent's advertised `models` (`details.allowed` lists the keys) |
| 400 | `invalid_budget` | Not a budget, or one at or below what the conversation has already spent |
| 400 | `budget_unavailable` | The agent has no pricing, so a budget cannot be counted against |
| 400 | `invalid_approved_args` | The edited arguments are not accepted by the tool's schema |
| 400 | `invalid_client_tool_result` | The result of a client tool is larger than hitl.clientToolMaxOutputBytes (details.maxBytes) |
| 400 | `invalid_feedback` | The rating, the reasons or the comment of a piece of feedback are not acceptable |
| 401 | `AUTHENTICATION_ERROR` | Missing or invalid credentials |
| 401 | `identity_required` | Listing needs to know who is asking (see allowAnonymousList) |
| 402 | `budget_reached` | The conversation's budget is used up; raise it to carry on |
| 403 | `FORBIDDEN` | The conversation, task or file belongs to someone else |
| 403 | `AUTHORIZATION_ERROR` | A host's own AuthorizationError (access denied) |
| 403 | `action_forbidden` | hitl.authorizeResolve says you may not answer this request |
| 403 | `budget_forbidden` | Raising or removing a budget needs the authorizeBudget option |
| 403 | `attachments_disabled` | The agent does not take attachments |
| 403 | `action_disabled` | The agent's experience switches this action off (regenerate, edit, rename, pin ...), or the conversation's agent cannot be resolved any more (`details.reason: "agent_unavailable"`); details.setting says which |
| 403 | `feedback_disabled` | The agent does not take feedback on its answers (or cannot be resolved any more: `details.reason: "agent_unavailable"`) |
| 403 | `export_disabled` | Downloading conversations (or including tool calls in the download) is switched off for the agent, or the agent cannot be resolved any more (`details.reason: "agent_unavailable"`) |
| 404 | `NOT_FOUND` | The agent, conversation, message, task, file or tool does not exist (or is not yours) |
| 409 | `action_pending` | A message or continue while a request is open (details.pendingActionIds) |
| 409 | `action_not_pending` | The action is unknown, already answered, or cannot be resumed |
| 409 | `conversation_busy` | A turn is already running in the conversation (details.activeRunId) |
| 409 | `invalid_message_target` | The message is not one the action applies to: only the newest message can be regenerated, only a person's own message edited, only an answer rated (details.reason) |
| 409 | `conversation_conflict` | The conversation kept changing under the request; try again |
| 409 | `lease_lost` | Another node took the conversation over while the turn ran |
| 409 | `nothing_to_continue` | No turn was stopped by the budget |
| 409 | `task_busy` | The task is running or waits on an action |
| 409 | `task_finished` | The task has already completed or failed |
| 409 | `too_many_files` | The conversation already holds as many files as the agent allows |
| 410 | `action_expired` | The approval or question lapsed (expiresAt) |
| 413 | `PAYLOAD_TOO_LARGE` | The request body is over the body limit |
| 413 | `STORAGE_LIMIT_EXCEEDED` | The storage provider cannot hold this much |
| 415 | `unsupported_file_type` | The file's type is not one the agent accepts |
| 415 | `unsupported_media_type` | An upload sent as multipart/form-data or a form (send the raw bytes with ?name=, or the JSON form) |
| 429 | `rate_limited` | The rateLimit hook refused the request; Retry-After and details.retryAfterSeconds say when to try again |
| 500 | `INTERNAL_ERROR` | Anything unexpected (the text is generic with maskServerErrors) |
| 500 | `budget_misconfigured` | The agent has a budget but no pricing |
| 500 | `invalid_host_result` | A host agent returned something the server cannot use |
| 501 | `export_format_unsupported` | format=pdf and the server has no export.renderPdf; use format=html&print=1 and save the page as PDF |

A turn can also carry **warnings** that are not errors (`warnings` on the response, on `stream.done` and in the assistant message's `metadata`): `pause_state_too_large` (the turn finished instead of
pausing, see [Storage](./storage.md)), `file_truncated`, `file_unreadable` and `images_not_supported` (see [Files](./file-management.md)). The event log has `run_interrupted` for a run whose server died (see [Runs](./runs.md#recovery)).

## Handling Errors in Custom Agents

```typescript
agentServer.registerCustomAgent('my-agent', {
  processMessage: async ({ message }) => {
    try {
      const result = await processMessage(message);
      return { content: result };
    } catch (error) {
      // Log the error
      console.error('Agent error:', error);
      
      // Handle specific error types
      if (error instanceof RateLimitError) {
        throw new ValidationError('Rate limit exceeded. Please try again later.');
      }
      
      if (error instanceof ModelError) {
        throw new AgentServerError('AI model error. Please try again.', 'model_unavailable', 502);
      }
      
      // Re-throw unknown errors
      throw error;
    }
  },
});
```

## Express Error Handling

```typescript
import express from 'express';
import { createExpressMiddleware } from '@cognipeer/agent-server';

const app = express();

// Agent server middleware
app.use(createExpressMiddleware(agentServer));

// Global error handler (must be last)
app.use((err, req, res, next) => {
  console.error('Error:', err);
  
  // Get status code from error
  const status = err.statusCode || 500;
  
  // Build error response
  const response: Record<string, unknown> = {
    error: { code: err.code || 'INTERNAL_ERROR', message: err.message || 'Internal Server Error' },
  };
  
  // Include stack in development
  if (process.env.NODE_ENV === 'development') {
    (response.error as Record<string, unknown>).stack = err.stack;
  }
  
  res.status(status).json(response);
});
```

## Next.js Error Handling

```typescript
// app/api/agents/[...path]/route.ts
import { createNextRouteHandlers } from '@cognipeer/agent-server';
import { NextResponse } from 'next/server';

const handlers = createNextRouteHandlers(agentServer);

export async function GET(request: Request, context: any) {
  try {
    return await handlers.GET(request, context);
  } catch (error) {
    console.error('API Error:', error);
    
    const status = error.statusCode || 500;
    return NextResponse.json(
      { error: { code: error.code || 'INTERNAL_ERROR', message: error.message || 'Internal Server Error' } },
      { status }
    );
  }
}

export async function POST(request: Request, context: any) {
  try {
    return await handlers.POST(request, context);
  } catch (error) {
    console.error('API Error:', error);
    
    const status = error.statusCode || 500;
    return NextResponse.json(
      { error: { code: error.code || 'INTERNAL_ERROR', message: error.message || 'Internal Server Error' } },
      { status }
    );
  }
}
```

## Validation Errors

Validate input before processing:

```typescript
import { z } from 'zod';

const messageSchema = z.object({
  message: z.string().min(1).max(10000),
  files: z.array(z.string()).optional(),
  streaming: z.boolean().optional(),
});

agentServer.registerCustomAgent('validated-agent', {
  processMessage: async (params) => {
    // Validate input
    const validation = messageSchema.safeParse({
      message: params.message,
      files: params.files?.map(f => f.id),
    });
    
    if (!validation.success) {
      throw new ValidationError(
        'Invalid input: ' + validation.error.errors[0].message
      );
    }
    
    // Process validated input
    return { content: 'Processed successfully' };
  },
});
```

## Error Logging

Implement proper error logging:

```typescript
import { createLogger, format, transports } from 'winston';

const logger = createLogger({
  level: 'error',
  format: format.combine(
    format.timestamp(),
    format.errors({ stack: true }),
    format.json()
  ),
  transports: [
    new transports.File({ filename: 'error.log' }),
    new transports.Console({ format: format.simple() }),
  ],
});

// In error handler
app.use((err, req, res, next) => {
  logger.error('Request error', {
    error: err.message,
    stack: err.stack,
    path: req.path,
    method: req.method,
    userId: req.user?.id,
  });
  
  res.status(err.statusCode || 500).json({
    error: { code: err.code || 'INTERNAL_ERROR', message: err.message },
  });
});
```

## Error Monitoring

Integrate with error monitoring services:

```typescript
import * as Sentry from '@sentry/node';

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: process.env.NODE_ENV,
});

// In error handler
app.use((err, req, res, next) => {
  // Report to Sentry
  Sentry.captureException(err, {
    user: { id: req.user?.id },
    extra: {
      path: req.path,
      method: req.method,
    },
  });
  
  res.status(err.statusCode || 500).json({
    error: { code: err.code || 'INTERNAL_ERROR', message: err.message },
  });
});
```

## Retry Logic

Implement retries for transient errors:

```typescript
async function withRetry<T>(
  fn: () => Promise<T>,
  options: { maxRetries?: number; delay?: number } = {}
): Promise<T> {
  const { maxRetries = 3, delay = 1000 } = options;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt === maxRetries) throw error;
      
      // Only retry on transient errors
      if (isTransientError(error)) {
        await sleep(delay * attempt);
        continue;
      }
      
      throw error;
    }
  }
  
  throw new Error('Max retries exceeded');
}

function isTransientError(error: Error): boolean {
  return (
    error.message.includes('rate limit') ||
    error.message.includes('timeout') ||
    error.message.includes('connection')
  );
}

// Usage in agent
agentServer.registerCustomAgent('reliable-agent', {
  processMessage: async ({ message }) => {
    const result = await withRetry(() => 
      callAIService(message)
    );
    return { content: result };
  },
});
```

## Client-Side Error Handling

Handle errors in the client:

```typescript
// Using fetch
try {
  const response = await fetch('/api/agents/conversations/123/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: 'Hello' }),
  });
  
  if (!response.ok) {
    const error = await response.json();
    throw Object.assign(new Error(error.error?.message || 'Request failed'), { code: error.error?.code });
  }
  
  const data = await response.json();
} catch (error) {
  console.error('Error:', error);
  // Show error to user
}

// Using @cognipeer/chat-ui
<Chat
  baseUrl="/api/agents"
  agentId="assistant"
  onError={(error) => {
    console.error('Chat error:', error);
    toast.error(error.message);
  }}
/>
```

## Best Practices

1. **Never expose internal errors** - Return user-friendly messages
2. **Log all errors** - Use structured logging for debugging
3. **Monitor errors** - Set up alerts for critical errors
4. **Handle gracefully** - Provide fallback behavior
5. **Retry transient errors** - Improve reliability
6. **Validate early** - Catch errors before processing

## Next Steps

- [API Reference](/api/server)
- [Examples](/examples/)
