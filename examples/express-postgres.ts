// @ts-nocheck - Example file, types installed at runtime
/**
 * Example: Express + PostgreSQL + Agent SDK
 *
 * Bu örnek, agent-server'ın Express.js ile nasıl kullanılacağını gösterir.
 *
 * Çalıştırmak için:
 * 1. PostgreSQL veritabanı oluşturun
 * 2. Environment variable'ları ayarlayın
 * 3. npm install
 * 4. npx tsx examples/express-postgres.ts
 */

import express from 'express';
import {
  createAgentServer,
  createPostgresProvider,
  createExpressMiddleware,
  createCorsMiddleware,
  createTokenAuthProvider,
} from '../src/index.js';

// Environment variables
const PORT = process.env.PORT || 3000;
const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://localhost:5432/agent_server';
const AUTH_ENABLED = process.env.AUTH_ENABLED === 'true';
const API_KEY = process.env.API_KEY || 'test-api-key';

async function main() {
  // 1. Storage provider oluştur
  const storage = createPostgresProvider({
    connectionString: DATABASE_URL,
    autoMigrate: true,
  });

  // 2. Auth provider oluştur (opsiyonel)
  const authProvider = createTokenAuthProvider({
    tokens: { [API_KEY]: 'demo-user' },
  });

  // 3. Agent server oluştur
  const agentServer = createAgentServer({
    basePath: '/api/agents',
    storage,
    swagger: {
      enabled: true,
      path: '/docs',
      title: 'Agent Server Demo',
      version: '1.0.0',
      description: 'Demo API for AI agents',
    },
    auth: {
      enabled: AUTH_ENABLED,
      provider: authProvider,
      excludeRoutes: ['/docs', '/docs/*', '/agents'],
    },
    cors: {
      enabled: true,
      origins: ['*'],
    },
    limits: {
      maxFileSize: 10 * 1024 * 1024, // 10MB
      maxBodySize: 1 * 1024 * 1024,  // 1MB
    },
  });

  // 4. Demo agent'ları register et

  // Echo agent - basit bir test agent'ı
  agentServer.registerCustomAgent('echo', {
    processMessage: async ({ message }) => ({
      content: `Echo: ${message}`,
      usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
    }),
  }, {
    name: 'Echo Bot',
    description: 'Mesajlarınızı tekrar eder - test için kullanılır',
    version: '1.0.0',
  });

  // Greeting agent - selamlama agent'ı
  agentServer.registerCustomAgent('greeter', {
    processMessage: async ({ message, state }) => {
      const greetCount = (state?.greetCount as number || 0) + 1;
      const name = message.match(/benim adım (\w+)/i)?.[1] || 'Misafir';

      return {
        content: `Merhaba ${name}! Bu senin ${greetCount}. mesajın.`,
        state: { greetCount, lastGreeted: name },
        usage: { inputTokens: 15, outputTokens: 20, totalTokens: 35 },
      };
    },
  }, {
    name: 'Greeter Bot',
    description: 'Sizi selamlayan dostane bir bot',
    version: '1.0.0',
    metadata: { capabilities: ['greeting', 'memory'] },
  });

  // Calculator agent - hesap makinesi
  agentServer.registerCustomAgent('calculator', {
    processMessage: async ({ message }) => {
      try {
        // Basit matematik ifadelerini değerlendir
        const expr = message.replace(/[^0-9+\-*/().]/g, '');
        if (!expr) {
          return { content: 'Lütfen bir matematik ifadesi girin (örn: 2 + 2)' };
        }
        // eslint-disable-next-line no-eval
        const result = eval(expr);
        return { content: `${expr} = ${result}` };
      } catch {
        return { content: 'Geçersiz matematik ifadesi' };
      }
    },
  }, {
    name: 'Calculator Bot',
    description: 'Basit matematik işlemleri yapar',
    version: '1.0.0',
  });

  // 5. Express uygulamasını oluştur
  const app = express();

  // Middleware'ler
  app.use(express.json({ limit: '1mb' }));
  app.use(createCorsMiddleware(['*']));

  // Health check
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // Agent server middleware'i ekle
  app.use(createExpressMiddleware(agentServer));

  // 6. Storage'a bağlan ve server'ı başlat
  console.log('Connecting to database...');
  await storage.connect();
  console.log('Database connected!');

  app.listen(PORT, () => {
    console.log(`
🚀 Agent Server running!

   Base URL:    http://localhost:${PORT}/api/agents
   Swagger UI:  http://localhost:${PORT}/api/agents/docs
   Health:      http://localhost:${PORT}/health

📝 Available Agents:
   - echo      : Echoes your messages
   - greeter   : Greets you and remembers your name
   - calculator: Does simple math

${AUTH_ENABLED ? `🔐 Authentication ENABLED (use header: Authorization: Bearer ${API_KEY})` : '🔓 Authentication DISABLED'}

Try it:
   curl http://localhost:${PORT}/api/agents/agents
   curl http://localhost:${PORT}/api/agents/conversations -X POST -H "Content-Type: application/json" -d '{"agentId": "echo"}'
    `);
  });

  // Graceful shutdown
  process.on('SIGTERM', async () => {
    console.log('Shutting down...');
    await storage.disconnect();
    process.exit(0);
  });
}

main().catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});
