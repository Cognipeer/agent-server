# @cognipeer/agent-server

REST API sunucu altyapısı - AI agent'ları için hazır bir API katmanı.

## Özellikler

- 🤖 **Agent SDK Entegrasyonu**: `@cognipeer/agent-sdk` ile oluşturulmuş agent'ları doğrudan register edebilme
- 🔧 **Custom Handler Desteği**: Farklı kütüphanelerle oluşturulmuş agent'ları entegre etme
- 💾 **Çoklu Storage**: PostgreSQL ve MongoDB desteği
- 🔐 **Authentication**: Token-based ve JWT authentication
- 📚 **Swagger UI**: Otomatik OpenAPI dokümantasyonu
- 🌐 **Framework Agnostik**: Express, Next.js ve diğer framework'lerle çalışır
- 📁 **Dosya Yönetimi**: Dosya yükleme ve AI'ın gönderdiği dosyaları görüntüleme

## Kurulum

```bash
npm install @cognipeer/agent-server
```

Ek olarak kullanmak istediğiniz storage provider ve framework'ü kurmanız gerekir:

```bash
# PostgreSQL için
npm install pg

# MongoDB için
npm install mongodb

# Express için
npm install express
```

## Hızlı Başlangıç

### Express ile Kullanım

```typescript
import express from 'express';
import {
  createAgentServer,
  createPostgresProvider,
  createExpressMiddleware,
} from '@cognipeer/agent-server';
import { createSmartAgent } from '@cognipeer/agent-sdk';

// Storage provider oluştur
const storage = createPostgresProvider({
  connectionString: 'postgresql://user:pass@localhost:5432/mydb',
});

// Agent server oluştur
const agentServer = createAgentServer({
  basePath: '/api/agents',
  storage,
  swagger: {
    enabled: true,
    path: '/docs',
    title: 'My Agent API',
  },
  auth: {
    enabled: false, // Başlangıç için kapalı
  },
});

// SDK agent'ı register et
const myAgent = createSmartAgent({
  name: 'Assistant',
  model: myLLMModel,
  tools: [...],
});
agentServer.registerSDKAgent('assistant', myAgent, {
  description: 'A helpful assistant',
});

// Custom agent register et
agentServer.registerCustomAgent('echo', {
  processMessage: async ({ message }) => ({
    content: `Echo: ${message}`,
  }),
}, {
  name: 'Echo Bot',
  description: 'Echoes your messages',
});

// Express app oluştur
const app = express();
app.use(express.json());

// Storage'a bağlan ve server'ı başlat
await storage.connect();
app.use(createExpressMiddleware(agentServer));

app.listen(3000, () => {
  console.log('Server running at http://localhost:3000');
  console.log('Swagger UI at http://localhost:3000/api/agents/docs');
});
```

### Next.js App Router ile Kullanım

```typescript
// app/api/agents/[...path]/route.ts
import {
  createAgentServer,
  createMongoDBProvider,
  createNextRouteHandlers,
} from '@cognipeer/agent-server';

const storage = createMongoDBProvider({
  connectionString: 'mongodb://localhost:27017/mydb',
});

const agentServer = createAgentServer({
  basePath: '/api/agents',
  storage,
  swagger: { enabled: true },
});

// Agent'ları register et
// ...

// Storage'a bağlan
await storage.connect();

// Route handler'ları export et
export const { GET, POST, PATCH, DELETE, OPTIONS } = createNextRouteHandlers(agentServer);
```

## API Endpoints

| Method | Endpoint | Açıklama |
|--------|----------|----------|
| GET | /agents | Tüm agent'ları listele |
| GET | /agents/:agentId | Agent detayı |
| GET | /conversations | Konuşmaları listele |
| POST | /conversations | Yeni konuşma oluştur |
| GET | /conversations/:id | Konuşma detayı ve mesajlar |
| PATCH | /conversations/:id | Konuşma güncelle |
| DELETE | /conversations/:id | Konuşma sil |
| GET | /conversations/:id/messages | Mesajları listele |
| POST | /conversations/:id/messages | Mesaj gönder |
| POST | /files | Dosya yükle |
| GET | /files/:fileId | Dosya metadata |
| GET | /files/:fileId/content | Dosya indir |
| DELETE | /files/:fileId | Dosya sil |

## Storage Providers

### PostgreSQL

```typescript
import { createPostgresProvider } from '@cognipeer/agent-server';

const storage = createPostgresProvider({
  // Connection string ile
  connectionString: 'postgresql://user:pass@localhost:5432/mydb',

  // Veya ayrı parametrelerle
  host: 'localhost',
  port: 5432,
  database: 'mydb',
  user: 'user',
  password: 'pass',

  // Opsiyonel
  schema: 'public',          // Default: 'public'
  tablePrefix: 'agent_',     // Default: 'agent_server_'
  autoMigrate: true,         // Default: true - tabloları otomatik oluştur
  pool: {
    min: 2,
    max: 10,
  },
});

await storage.connect();
```

### MongoDB

```typescript
import { createMongoDBProvider } from '@cognipeer/agent-server';

const storage = createMongoDBProvider({
  connectionString: 'mongodb://localhost:27017/mydb',
  database: 'mydb',              // Opsiyonel
  collectionPrefix: 'agent_',    // Default: 'agent_server_'
  autoIndex: true,               // Default: true
});

await storage.connect();
```

## Authentication

### Token-Based Auth

```typescript
import { createTokenAuthProvider } from '@cognipeer/agent-server';

const authProvider = createTokenAuthProvider({
  // Static token'lar
  tokens: {
    'my-api-key': 'user-1',
    'another-key': 'user-2',
  },

  // Veya custom validation
  validateFn: async (token) => {
    const user = await myDatabase.findUserByToken(token);
    if (user) {
      return { valid: true, userId: user.id };
    }
    return { valid: false, error: 'Invalid token' };
  },
});

const agentServer = createAgentServer({
  // ...
  auth: {
    enabled: true,
    provider: authProvider,
    headerName: 'Authorization',    // Default
    tokenPrefix: 'Bearer ',         // Default
    excludeRoutes: ['/docs', '/docs/*'],  // Auth'suz erişilebilir route'lar
  },
});
```

### JWT Auth

```typescript
import { createJWTAuthProvider } from '@cognipeer/agent-server';

const authProvider = createJWTAuthProvider({
  secret: 'my-jwt-secret',
  algorithm: 'HS256',           // Default
  issuer: 'my-app',             // Opsiyonel - doğrulama için
  audience: 'my-api',           // Opsiyonel - doğrulama için
  extractUserId: (payload) => payload.sub as string,
});
```

## Custom Agent Handler

SDK kullanmadan kendi agent'ınızı entegre edebilirsiniz:

```typescript
agentServer.registerCustomAgent('my-agent', {
  processMessage: async (params) => {
    const { conversationId, message, files, state, metadata } = params;

    // Kendi AI logic'iniz
    const response = await myAIService.chat(message, {
      history: await getHistory(conversationId),
      files,
    });

    return {
      content: response.text,
      files: response.attachments,
      state: { ...state, lastMessageAt: new Date() },
      usage: {
        inputTokens: response.usage.prompt,
        outputTokens: response.usage.completion,
        totalTokens: response.usage.total,
      },
    };
  },
}, {
  name: 'My Custom Agent',
  description: 'A custom AI agent',
  version: '1.0.0',
  metadata: { capabilities: ['chat', 'files'] },
});
```

## Custom Storage Provider

Kendi storage provider'ınızı oluşturabilirsiniz:

```typescript
import { BaseStorageProvider } from '@cognipeer/agent-server';

class MyStorageProvider extends BaseStorageProvider {
  async connect() {
    // Bağlantı kur
    this._connected = true;
  }

  async disconnect() {
    // Bağlantıyı kapat
    this._connected = false;
  }

  protected async _createConversation(id, params) {
    // Konuşma oluştur
  }

  // Diğer abstract metodları implement et...
}
```

## CORS Yapılandırması

```typescript
const agentServer = createAgentServer({
  // ...
  cors: {
    enabled: true,
    origins: ['http://localhost:3000', 'https://myapp.com'],
    methods: ['GET', 'POST', 'PATCH', 'DELETE'],
    headers: ['Content-Type', 'Authorization'],
  },
});
```

## Swagger UI

```typescript
const agentServer = createAgentServer({
  // ...
  swagger: {
    enabled: true,
    path: '/docs',           // Default: '/docs'
    title: 'My Agent API',   // API başlığı
    version: '1.0.0',        // API versiyonu
    description: 'AI Agent REST API',
  },
});
```

Swagger UI'a `{basePath}/docs` adresinden erişebilirsiniz.
OpenAPI spec'i `{basePath}/docs/openapi.json` adresinde bulunur.

## İleriki Adımlar

- [ ] HTTP Event Stream (SSE) desteği - real-time response streaming
- [ ] WebSocket desteği
- [ ] Rate limiting
- [ ] Request logging
- [ ] Metrics ve monitoring

## Lisans

MIT
