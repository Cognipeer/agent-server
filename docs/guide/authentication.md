# Authentication

Secure your API with built-in authentication providers.

## Token-Based Authentication

Simple API key authentication for internal services.

```typescript
import { createTokenAuthProvider } from '@cognipeer/agent-server';

const authProvider = createTokenAuthProvider({
  // Static token mapping: token -> userId
  tokens: {
    'api-key-1': 'user-1',
    'api-key-2': 'user-2',
    [process.env.ADMIN_API_KEY]: 'admin',
  },
});

const agentServer = createAgentServer({
  // ...
  auth: {
    enabled: true,
    provider: authProvider,
    headerName: 'Authorization',     // Default
    tokenPrefix: 'Bearer ',          // Default
    excludeRoutes: ['/docs', '/docs/*'],
  },
});
```

### Dynamic Token Validation

```typescript
const authProvider = createTokenAuthProvider({
  // Custom validation function
  validateFn: async (token) => {
    const user = await database.findUserByApiKey(token);
    
    if (user) {
      return {
        valid: true,
        userId: user.id,
      };
    }
    
    return {
      valid: false,
      error: 'Invalid API key',
    };
  },
});
```

## JWT Authentication

JSON Web Token authentication for user-facing applications.

```typescript
import { createJWTAuthProvider } from '@cognipeer/agent-server';

const authProvider = createJWTAuthProvider({
  secret: process.env.JWT_SECRET,
  algorithm: 'HS256',              // Default
  issuer: 'my-app',                // Optional - validate issuer
  audience: 'my-api',              // Optional - validate audience
  extractUserId: (payload) => payload.sub as string,
});
```

### RSA Keys

```typescript
import { readFileSync } from 'fs';

const authProvider = createJWTAuthProvider({
  publicKey: readFileSync('./public.pem', 'utf-8'),
  algorithm: 'RS256',
  extractUserId: (payload) => payload.userId as string,
});
```

### JWKS Support

```typescript
const authProvider = createJWTAuthProvider({
  jwksUri: 'https://auth.example.com/.well-known/jwks.json',
  algorithm: 'RS256',
  issuer: 'https://auth.example.com',
  extractUserId: (payload) => payload.sub as string,
});
```

## Configuration Options

### Auth Configuration

```typescript
interface AuthConfig {
  // Enable authentication
  enabled: boolean;
  
  // Auth provider instance
  provider: AuthProvider;
  
  // Header name for token (default: 'Authorization')
  headerName?: string;
  
  // Token prefix to strip (default: 'Bearer ')
  tokenPrefix?: string;
  
  // Routes that don't require authentication
  excludeRoutes?: string[];
  
  // Custom userId resolver (when not using token auth)
  resolveUserId?: (ctx: { query: Record<string, string>; body?: unknown }) => Promise<string | undefined>;
}
```

### Exclude Routes

```typescript
auth: {
  enabled: true,
  provider: authProvider,
  excludeRoutes: [
    '/docs',           // Exact match
    '/docs/*',         // Wildcard - matches /docs/openapi.json
    '/agents',         // Public agent list
    '/health',         // Health check
  ],
}
```

## Client Usage

### Token Auth

```bash
# Using cURL
curl -H "Authorization: Bearer your-api-key" \
  http://localhost:3000/api/agents/conversations

# Using fetch
fetch('/api/agents/conversations', {
  headers: {
    'Authorization': 'Bearer your-api-key',
  },
});
```

### JWT Auth

```typescript
// Login to get JWT
const { token } = await login(username, password);

// Use token in requests
const response = await fetch('/api/agents/conversations', {
  headers: {
    'Authorization': `Bearer ${token}`,
  },
});
```

## Custom Auth Provider

Create your own authentication provider:

```typescript
interface AuthProvider {
  validate(token: string): Promise<AuthResult>;
}

interface AuthResult {
  valid: boolean;
  userId?: string;
  error?: string;
}

class MyAuthProvider implements AuthProvider {
  async validate(token: string): Promise<AuthResult> {
    try {
      // Validate with your auth service
      const user = await myAuthService.validateToken(token);
      
      if (user) {
        return {
          valid: true,
          userId: user.id,
        };
      }
      
      return {
        valid: false,
        error: 'Invalid token',
      };
    } catch (error) {
      return {
        valid: false,
        error: 'Authentication failed',
      };
    }
  }
}

const authProvider = new MyAuthProvider();
```

## User ID Resolution

### From Token

The userId is automatically extracted from token validation:

```typescript
const authProvider = createTokenAuthProvider({
  tokens: {
    'api-key-1': 'user-123',  // 'user-123' becomes ctx.user.id
  },
});
```

### From Query/Body

For unauthenticated scenarios, use `resolveUserId`:

```typescript
auth: {
  enabled: false,  // No token auth
  resolveUserId: async (ctx) => {
    // Get userId from query param
    return ctx.query.userId as string;
    
    // Or from body
    // return (ctx.body as any)?.userId;
  },
}
```

## Multi-tenant Setup

```typescript
const authProvider = createJWTAuthProvider({
  secret: process.env.JWT_SECRET,
  extractUserId: (payload) => payload.sub as string,
});

// Conversations are automatically filtered by userId
// when userId is set in the auth context
const agentServer = createAgentServer({
  basePath: '/api/agents',
  storage,
  auth: {
    enabled: true,
    provider: authProvider,
  },
});

// User A can only see their own conversations
// User B can only see their own conversations
```

## Security Best Practices

1. **Use HTTPS** - Always use HTTPS in production
2. **Short-lived tokens** - Use short expiration times for JWTs
3. **Rotate secrets** - Regularly rotate JWT secrets
4. **Validate issuer/audience** - For JWTs, always validate `iss` and `aud`
5. **Rate limiting** - Implement rate limiting to prevent abuse
6. **Log auth failures** - Monitor and log authentication failures

## Error Responses

```json
// 401 Unauthorized
{
  "error": "Authentication required"
}

// 401 Unauthorized (invalid token)
{
  "error": "Invalid token"
}

// 403 Forbidden (valid token, no access)
{
  "error": "Access denied"
}
```

## Next Steps

- [File Management](/guide/file-management)
- [Streaming](/guide/streaming)
- [Custom Agents](/guide/custom-agents)
