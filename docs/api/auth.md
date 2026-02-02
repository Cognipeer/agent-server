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
}
```

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
  // Secret for HMAC algorithms (HS256, HS384, HS512)
  secret?: string;

  // Public key for RSA/EC algorithms
  publicKey?: string;

  // JWKS URI for key rotation
  jwksUri?: string;

  // Algorithm (default: 'HS256')
  algorithm?: 'HS256' | 'HS384' | 'HS512' | 'RS256' | 'RS384' | 'RS512' | 'ES256' | 'ES384' | 'ES512';

  // Expected issuer (validates 'iss' claim)
  issuer?: string;

  // Expected audience (validates 'aud' claim)
  audience?: string;

  // Extract userId from JWT payload
  extractUserId: (payload: JWTPayload) => string;
}
```

### Example with Secret

```typescript
const authProvider = createJWTAuthProvider({
  secret: process.env.JWT_SECRET,
  algorithm: 'HS256',
  extractUserId: (payload) => payload.sub as string,
});
```

### Example with RSA

```typescript
import { readFileSync } from 'fs';

const authProvider = createJWTAuthProvider({
  publicKey: readFileSync('./public.pem', 'utf-8'),
  algorithm: 'RS256',
  issuer: 'https://auth.example.com',
  audience: 'my-api',
  extractUserId: (payload) => payload.userId as string,
});
```

### Example with JWKS

```typescript
const authProvider = createJWTAuthProvider({
  jwksUri: 'https://auth.example.com/.well-known/jwks.json',
  algorithm: 'RS256',
  issuer: 'https://auth.example.com',
  extractUserId: (payload) => payload.sub as string,
});
```

## AuthProvider Interface

All auth providers implement this interface:

```typescript
interface AuthProvider {
  validate(token: string): Promise<AuthResult>;
}

interface AuthResult {
  valid: boolean;
  userId?: string;
  error?: string;
}
```

## Custom Auth Provider

Create your own authentication provider:

```typescript
class MyAuthProvider implements AuthProvider {
  async validate(token: string): Promise<AuthResult> {
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
    
    // Auth provider
    provider: authProvider,
    
    // Header name (default: 'Authorization')
    headerName: 'Authorization',
    
    // Token prefix (default: 'Bearer ')
    tokenPrefix: 'Bearer ',
    
    // Routes that don't require auth
    excludeRoutes: ['/docs', '/docs/*', '/agents'],
    
    // Custom userId resolver (for non-token auth)
    resolveUserId: async (ctx) => {
      // Get userId from query param or body
      return ctx.query.userId || ctx.body?.userId;
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

### 401 Unauthorized

When authentication fails:

```json
{
  "error": "Authentication required"
}
```

```json
{
  "error": "Invalid token"
}
```

### 403 Forbidden

When user doesn't have access:

```json
{
  "error": "Access denied"
}
```
