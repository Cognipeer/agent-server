# Auth Providers API

API reference for authentication providers.

## createTokenAuthProvider

Creates a token-based authentication provider.

```typescript
import { createTokenAuthProvider } from '@cognipeer/agent-server';

const authProvider = createTokenAuthProvider(config);
```

### Configuration

```typescript
interface TokenAuthConfig {
  // Static token to userId mapping
  tokens?: Record<string, string>;

  // Dynamic validation function
  validateFn?: (token: string) => Promise<AuthResult>;

  // How long a token made by generateToken() is good for, in milliseconds (default: until revoked)
  tokenTtlMs?: number;
}
```

`generateToken(userId)` returns `tok_` plus 256 random bits (base64url): nothing in it comes from the user or the time, so it cannot be guessed. The provider keeps only a hash of it, in memory -
generated tokens are lost when the process ends, so they suit tests and single-process tools; for sessions that must outlive a restart, issue and store tokens yourself and validate them with `validateFn`.
`revokeToken(token)` ends one.

### Example with Static Tokens

```typescript
const authProvider = createTokenAuthProvider({
  tokens: {
    'api-key-1': 'user-1',
    'api-key-2': 'user-2',
    [process.env.ADMIN_KEY]: 'admin',
  },
});
```

### Example with Custom Validation

```typescript
const authProvider = createTokenAuthProvider({
  validateFn: async (token) => {
    const user = await database.findUserByApiKey(token);
    
    if (user) {
      return { valid: true, userId: user.id };
    }
    
    return { valid: false, error: 'Invalid API key' };
  },
});
```

### Combined Usage

```typescript
const authProvider = createTokenAuthProvider({
  // Check static tokens first
  tokens: {
    'static-key': 'static-user',
  },
  // Fallback to dynamic validation
  validateFn: async (token) => {
    const user = await database.findUserByApiKey(token);
    if (user) return { valid: true, userId: user.id };
    return { valid: false };
  },
});
```

## createJWTAuthProvider

Creates a JWT authentication provider.

```typescript
import { createJWTAuthProvider } from '@cognipeer/agent-server';

const authProvider = createJWTAuthProvider(config);
```

### Configuration

```typescript
interface JWTAuthConfig {
  // The shared secret (HS*), or the PEM public key / certificate (RS*, ES*). Required.
  secret: string;

  // The one algorithm tokens must be signed with (default: 'HS256')
  algorithm?: 'HS256' | 'HS384' | 'HS512' | 'RS256' | 'RS384' | 'RS512' | 'ES256' | 'ES384' | 'ES512';

  // Expected issuer (checks the 'iss' claim)
  issuer?: string;

  // Expected audience (checks the 'aud' claim, which may be a string or a list). A list here accepts any of them.
  audience?: string | string[];

  // Seconds of clock difference allowed for 'exp' and 'nbf' (default 0)
  clockToleranceSec?: number;

  // Refuse a token without 'exp' (default false)
  requireExp?: boolean;

  // Extract the user id from the payload (default: sub, then userId, then user_id)
  extractUserId?: (payload: Record<string, unknown>) => string | undefined;
}
```

`createJWTAuthProvider` **verifies the token's signature** (HMAC, RSA or ECDSA, with `node:crypto`) against the configured key, and then checks `exp`, `nbf`, `iss` and `aud`. The algorithm is the
configured one: the token's header cannot change it, so `alg: "none"` and an RSA key used as an HMAC secret are refused. It throws when created without a `secret`, or with a `secret` that is not a
PEM key of the kind the algorithm needs.

::: warning No JWKS
It holds one static key and does not fetch keys, so it cannot follow a key rotation. For an identity provider that publishes a JWKS, put verification in front of the server (a gateway or an
identity-aware proxy), or write an `AuthProvider` that verifies with a JWT library (`jose`, `jsonwebtoken`) - see below.
:::

### Example

```typescript
const authProvider = createJWTAuthProvider({
  secret: process.env.JWT_SECRET!,
  algorithm: 'HS256',
  issuer: 'my-app',
  audience: 'my-api',
  extractUserId: (payload) => payload.sub as string,
});
```

### Verifying with a JWT library

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

## AuthProvider Interface

All auth providers implement this interface:

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
```

## Custom Auth Provider

Create your own authentication provider:

```typescript
class MyAuthProvider implements AuthProvider {
  async validateToken(token: string): Promise<AuthResult> {
    try {
      // Validate with your auth service
      const response = await fetch('https://auth.example.com/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      });
      
      if (!response.ok) {
        return { valid: false, error: 'Auth service error' };
      }
      
      const data = await response.json();
      
      if (data.valid) {
        return { valid: true, userId: data.userId };
      }
      
      return { valid: false, error: data.error };
    } catch (error) {
      return { valid: false, error: 'Authentication failed' };
    }
  }
}
```

## Auth Configuration

Configure authentication in the agent server:

```typescript
const agentServer = createAgentServer({
  basePath: '/api/agents',
  storage,
  auth: {
    // Enable authentication
    enabled: true,
    
    // Auth provider (required when enabled is true: createAgentServer throws without one)
    provider: authProvider,
    
    // Header name (default: 'Authorization')
    headerName: 'Authorization',
    
    // Token prefix (default: 'Bearer ')
    tokenPrefix: 'Bearer ',
    
    // Routes that don't require auth
    excludeRoutes: ['/docs', '/docs/*', '/agents'],
    
    // Custom userId resolver (for non-token auth)
    resolveUserId: async (ctx) => {
      // Get userId from a header or query param
      return (ctx.headers?.['x-user-id'] as string | undefined) ?? (ctx.query?.userId as string | undefined);
    },
  },
});
```

## Exclude Routes

Specify routes that don't require authentication:

```typescript
excludeRoutes: [
  '/docs',           // Exact match: /api/agents/docs
  '/docs/*',         // Wildcard: /api/agents/docs/openapi.json
  '/agents',         // Exact match: /api/agents/agents
  '/health',         // Health check endpoint
]
```

## Client Authentication

### Headers

```bash
# Bearer token
curl -H "Authorization: Bearer your-token" http://localhost:3000/api/agents/conversations

# Custom header
curl -H "X-API-Key: your-key" http://localhost:3000/api/agents/conversations
```

### In JavaScript

```typescript
// Using fetch
const response = await fetch('/api/agents/conversations', {
  headers: {
    'Authorization': 'Bearer your-token',
  },
});

// Using axios
const response = await axios.get('/api/agents/conversations', {
  headers: {
    'Authorization': 'Bearer your-token',
  },
});
```

## Error Responses

The body is always `{ "error": { "code", "message" } }`; see [Error Handling](../guide/error-handling).

### 401 Unauthorized

```json
{ "error": { "code": "AUTHENTICATION_ERROR", "message": "Authentication required" } }
```

```json
{ "error": { "code": "AUTHENTICATION_ERROR", "message": "Invalid token" } }
```

A request that names no user is also a `401` when it asks for a list: `identity_required` (see [Request Context](../guide/request-context#who-may-list)).

### 403 Forbidden

When the user is signed in but the conversation, task or file is somebody else's:

```json
{ "error": { "code": "FORBIDDEN", "message": "You do not have access to this conversation" } }
```
