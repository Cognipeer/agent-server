# Swagger UI

Automatic OpenAPI documentation with interactive Swagger UI.

## Overview

The agent server automatically generates OpenAPI documentation and provides an interactive Swagger UI for testing your API.

## Enabling Swagger

```typescript
const agentServer = createAgentServer({
  basePath: '/api/agents',
  storage,
  swagger: {
    enabled: true,
    path: '/docs',              // Default: '/docs'
    title: 'My Agent API',      // API title
    version: '1.0.0',           // API version
    description: 'AI Agent REST API documentation',
  },
});
```

## Accessing Documentation

Once enabled, you can access:

- **Swagger UI**: `{basePath}/docs`
- **OpenAPI JSON**: `{basePath}/docs/openapi.json`

For example:
- `http://localhost:3000/api/agents/docs`
- `http://localhost:3000/api/agents/docs/openapi.json`

## Configuration Options

```typescript
interface SwaggerConfig {
  // Enable/disable Swagger UI
  enabled: boolean;
  
  // Path for Swagger UI (relative to basePath)
  path?: string;
  
  // API title
  title?: string;
  
  // API version
  version?: string;
  
  // API description
  description?: string;
  
  // Contact information
  contact?: {
    name?: string;
    email?: string;
    url?: string;
  };
  
  // License information
  license?: {
    name: string;
    url?: string;
  };
  
  // Server URLs
  servers?: Array<{
    url: string;
    description?: string;
  }>;
}
```

## Example Configuration

```typescript
const agentServer = createAgentServer({
  basePath: '/api/agents',
  storage,
  swagger: {
    enabled: true,
    path: '/docs',
    title: 'My AI Agent API',
    version: '1.0.0',
    description: 'REST API for AI agents built with @cognipeer/agent-server',
    contact: {
      name: 'API Support',
      email: 'support@example.com',
      url: 'https://example.com/support',
    },
    license: {
      name: 'MIT',
      url: 'https://opensource.org/licenses/MIT',
    },
    servers: [
      { url: 'http://localhost:3000', description: 'Development' },
      { url: 'https://api.example.com', description: 'Production' },
    ],
  },
});
```

## Generated Endpoints

The OpenAPI spec includes all agent server endpoints:

### Agents

- `GET /agents` - List all registered agents
- `GET /agents/{agentId}` - Get agent details

### Conversations

- `GET /conversations` - List conversations
- `POST /conversations` - Create new conversation
- `GET /conversations/{id}` - Get conversation with messages
- `PATCH /conversations/{id}` - Update conversation
- `DELETE /conversations/{id}` - Delete conversation
- `GET /conversations/{id}/messages` - List messages
- `POST /conversations/{id}/messages` - Send message

### Files

- `POST /files` - Upload file
- `GET /files/{fileId}` - Get file metadata
- `GET /files/{fileId}/content` - Download file
- `DELETE /files/{fileId}` - Delete file

## Authentication in Swagger

If authentication is enabled, the Swagger UI includes auth options:

```yaml
securitySchemes:
  bearerAuth:
    type: http
    scheme: bearer
    bearerFormat: JWT
```

Use the "Authorize" button in Swagger UI to set your token.

## Custom Schemas

The OpenAPI spec includes detailed schemas for all types:

```yaml
components:
  schemas:
    Message:
      type: object
      properties:
        id:
          type: string
        conversationId:
          type: string
        role:
          type: string
          enum: [user, assistant, system, tool]
        content:
          oneOf:
            - type: string
            - type: array
              items:
                $ref: '#/components/schemas/ContentPart'
        toolCalls:
          type: array
          items:
            $ref: '#/components/schemas/ToolCall'
        files:
          type: array
          items:
            $ref: '#/components/schemas/FileAttachment'
        createdAt:
          type: string
          format: date-time
```

## Excluding Routes

Exclude routes from authentication while keeping them in docs:

```typescript
auth: {
  enabled: true,
  provider: authProvider,
  excludeRoutes: ['/docs', '/docs/*'],  // Public access to docs
}
```

## Production Considerations

### Disable in Production

You might want to disable Swagger in production:

```typescript
swagger: {
  enabled: process.env.NODE_ENV !== 'production',
}
```

### Or Use Authentication

Keep it enabled but require authentication:

```typescript
auth: {
  enabled: true,
  provider: authProvider,
  // Don't exclude /docs routes
  excludeRoutes: [],
}
```

## Customizing the UI

The generated Swagger UI uses the default SwaggerUI theme. For custom styling, you can:

1. Serve your own Swagger UI:

```typescript
// Disable built-in Swagger
swagger: { enabled: false }

// Serve custom Swagger UI
app.get('/docs', (req, res) => {
  res.send(customSwaggerHTML);
});

// Serve OpenAPI spec
app.get('/docs/openapi.json', (req, res) => {
  res.json(agentServer.getOpenAPISpec());
});
```

2. Use a different documentation tool:

```typescript
// Generate OpenAPI spec
const spec = agentServer.getOpenAPISpec();

// Use with Redoc, Rapidoc, etc.
```

## Programmatic Access

Access the OpenAPI spec programmatically:

```typescript
// Get the OpenAPI specification
const spec = agentServer.getOpenAPISpec();

// Save to file
fs.writeFileSync('openapi.json', JSON.stringify(spec, null, 2));

// Use for code generation
generateClient(spec);
```

## Next Steps

- [Custom Agents](/guide/custom-agents)
- [Custom Storage](/guide/custom-storage)
- [Error Handling](/guide/error-handling)
