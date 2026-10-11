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

```typescript
import { createJWTAuthProvider } from '@cognipeer/agent-server';

const authProvider = createJWTAuthProvider({
  secret: process.env.JWT_SECRET!,
  algorithm: 'HS256',              // Default; 'RS256' with a public key as the secret
  issuer: 'my-app',                // Optional - check the issuer
  audience: 'my-api',              // Optional - check the audience
  extractUserId: (payload) => payload.sub as string,   // Default: sub, then userId, then user_id
});
```

::: warning A basic provider
The built-in JWT provider reads a token's claims and checks `exp`, `issuer` and `audience`. It does **not** verify the signature and has no JWKS support. Verify the token in front of the
server (a gateway, an identity-aware proxy), or write an `AuthProvider` that verifies it with a JWT library such as `jose`:

```typescript
import { createRemoteJWKSet, jwtVerify } from 'jose';

const keys = createRemoteJWKSet(new URL('https://auth.example.com/.well-known/jwks.json'));

const authProvider: AuthProvider = {
  async validateToken(token) {
    try {
      const { payload } = await jwtVerify(token, keys, { issuer: 'https://auth.example.com', audience: 'my-api' });
      return { valid: true, userId: String(payload.sub), metadata: payload };
    } catch {
      return { valid: false, error: 'Invalid token' };
    }
  },
};
```
:::

## Configuration Options

### Auth Configuration

```typescript
interface AuthConfig {
  // Enable authentication
  enabled: boolean;
  
  // Auth provider instance (without one, token auth is off)
  provider?: AuthProvider;
  
  // Header name for token (default: 'Authorization')
  headerName?: string;
  
  // Token prefix to strip (default: 'Bearer ')
  tokenPrefix?: string;
  
  // Routes that don't require authentication
  excludeRoutes?: string[];
  
  // Custom userId resolver (when not using token auth)
  resolveUserId?: (ctx: { headers?: Record<string, string | string[] | undefined>; query: Record<string, string>; body?: unknown; context?: RequestContext }) => Promise<string | undefined>;
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
  validateToken(token: string): Promise<AuthResult>;
  generateToken?(userId: string, metadata?: Record<string, unknown>): Promise<string>;
  revokeToken?(token: string): Promise<void>;
}

interface AuthResult {
  valid: boolean;
  userId?: string;
  metadata?: Record<string, unknown>;
  error?: string;
}

class MyAuthProvider implements AuthProvider {
  async validateToken(token: string): Promise<AuthResult> {
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

### From a header, the query or the body

For unauthenticated scenarios, use `resolveUserId`:

```typescript
auth: {
  enabled: false,  // No token auth
  resolveUserId: async (ctx) => {
    // From a header (set by your gateway)
    return ctx.headers?.['x-user-id'] as string | undefined;

    // Or from the query: return ctx.query?.userId as string | undefined;
  },
}
```

### Listing needs a user

`GET /conversations` and `GET /tasks` return one user's records, so a request that names no user is refused with `401 identity_required` - unless the server sets `allowAnonymousList: true`
(a single-user tool or demo). Token auth, `resolveContext` with a `user`, `resolveUserId` or - without `resolveContext` - a `?userId=` query parameter all name a user.
See [Request Context](./request-context.md#who-may-list).

## Several users

```typescript
const agentServer = createAgentServer({
  basePath: '/api/agents',
  storage,
  auth: {
    enabled: true,
    provider: authProvider,
  },
});

// A conversation belongs to the user who created it:
// user A lists and opens only A's conversations, user B only B's (403 on someone else's)
```

The built-in storage providers hold every user's data in one namespace; they separate users, not tenants. For tenants, run a server per tenant (own database or `tablePrefix`), or scope in your
own storage provider using the request context ([Request Context](./request-context.md)).

## Security Best Practices

1. **Use HTTPS** - Always use HTTPS in production
2. **Short-lived tokens** - Use short expiration times for JWTs
3. **Rotate secrets** - Regularly rotate JWT secrets
4. **Validate issuer/audience** - For JWTs, always validate `iss` and `aud`
5. **Rate limiting** - Implement rate limiting to prevent abuse
6. **Log auth failures** - Monitor and log authentication failures

## Error Responses

The body is always `{ "error": { "code", "message" } }` (see [Error Handling](./error-handling.md)):

```json
// 401 Unauthorized
{ "error": { "code": "AUTHENTICATION_ERROR", "message": "Authentication required" } }

// 401 Unauthorized (invalid token)
{ "error": { "code": "AUTHENTICATION_ERROR", "message": "Invalid token" } }

// 401 Unauthorized (a list that names no user)
{ "error": { "code": "identity_required", "message": "Listing needs to know who is asking: sign in. ..." } }

// 403 Forbidden (signed in, but it is someone else's)
{ "error": { "code": "FORBIDDEN", "message": "You do not have access to this conversation" } }
```

## Next Steps

- [File Management](/guide/file-management)
- [Streaming](/guide/streaming)
- [Custom Agents](/guide/custom-agents)
