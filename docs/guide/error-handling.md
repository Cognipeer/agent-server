# Error Handling

Proper error handling in your agent server application.

## Error Types

The agent server includes several error types:

```typescript
// Authentication error (401)
class AuthenticationError extends Error {
  statusCode = 401;
}

// Not found error (404)
class NotFoundError extends Error {
  statusCode = 404;
}

// Validation error (400)
class ValidationError extends Error {
  statusCode = 400;
}

// Server error (500)
class ServerError extends Error {
  statusCode = 500;
}
```

## Error Responses

All errors are returned as JSON:

```json
{
  "error": "Error message here",
  "code": "ERROR_CODE",
  "details": {}
}
```

### Common Error Responses

#### 400 Bad Request

```json
{
  "error": "Invalid request body",
  "code": "VALIDATION_ERROR",
  "details": {
    "field": "message",
    "issue": "Required field missing"
  }
}
```

#### 401 Unauthorized

```json
{
  "error": "Authentication required",
  "code": "AUTH_REQUIRED"
}
```

#### 404 Not Found

```json
{
  "error": "Conversation not found",
  "code": "NOT_FOUND"
}
```

#### 500 Internal Server Error

```json
{
  "error": "Internal server error",
  "code": "SERVER_ERROR"
}
```

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
        throw new ServerError('AI model error. Please try again.');
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
  const response = {
    error: err.message || 'Internal Server Error',
    code: err.code || 'SERVER_ERROR',
  };
  
  // Include stack in development
  if (process.env.NODE_ENV === 'development') {
    response.stack = err.stack;
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
      { error: error.message || 'Internal Server Error' },
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
      { error: error.message || 'Internal Server Error' },
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
    error: err.message,
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
    error: err.message,
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
    throw new Error(error.error || 'Request failed');
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
