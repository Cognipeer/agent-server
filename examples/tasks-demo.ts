// @ts-nocheck - Example file, types installed at runtime
/**
 * Example: Task System Demo
 *
 * Bu örnek, Task sisteminin nasıl kullanılacağını gösterir.
 * Task'lar background job olarak çalışır ve tamamlandığında callback URL'e bildirim gönderir.
 *
 * Çalıştırmak için:
 * 1. npm install
 * 2. npx tsx examples/tasks-demo.ts
 */

import express from 'express';
import {
  createAgentServer,
  createInMemoryProvider,
} from '../src/index.js';

// Test için basit bir callback server
const callbackApp = express();
callbackApp.use(express.json());

const callbackResults: { taskId: string; status: string; timestamp: string }[] = [];

callbackApp.post('/callback', (req, res) => {
  console.log('\n✅ Callback received:', req.body);
  callbackResults.push(req.body);
  res.status(200).json({ received: true });
});

const CALLBACK_PORT = 3001;
callbackApp.listen(CALLBACK_PORT, () => {
  console.log(`📞 Callback server running on http://localhost:${CALLBACK_PORT}`);
});

async function main() {
  // 1. Storage provider oluştur
  const storage = createInMemoryProvider();

  // 2. Agent server oluştur
  const agentServer = createAgentServer({
    basePath: '/api/agents',
    storage,
    swagger: {
      enabled: true,
      path: '/docs',
      title: 'Task System Demo',
      version: '1.0.0',
      description: 'Demo API for Task background jobs',
    },
    cors: {
      enabled: true,
      origins: ['*'],
    },
  });

  // 3. Demo agent'ları register et

  // Simple task processor
  agentServer.registerCustomAgent('task-processor', {
    processMessage: async ({ message }) => {
      // Simulate some processing time
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      return {
        content: `Task completed! Processed: "${message}"`,
        usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
      };
    },
  }, {
    name: 'Task Processor',
    description: 'Simple task processor for background jobs',
    version: '1.0.0',
  });

  // Complex task processor with file support
  agentServer.registerCustomAgent('file-processor', {
    processMessage: async ({ message, files }) => {
      const fileInfo = files?.map(f => `${f.name} (${f.size} bytes)`).join(', ') || 'no files';
      await new Promise(resolve => setTimeout(resolve, 1500));
      
      return {
        content: `Processed message: "${message}" with files: ${fileInfo}`,
        files: files || [],
        usage: { inputTokens: 15, outputTokens: 25, totalTokens: 40 },
      };
    },
  }, {
    name: 'File Processor',
    description: 'Task processor with file handling',
    version: '1.0.0',
  });

  // 4. Express uygulamasını oluştur
  const app = express();
  const PORT = 3000;

  app.use(express.json());

  // Health check
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // Callback results endpoint
  app.get('/callback-results', (_req, res) => {
    res.json({ results: callbackResults });
  });

  // Task routes manually (since we don't have express adapter method)
  app.post('/api/agents/tasks', async (req, res) => {
    try {
      const result = await agentServer.handleRequest('POST', '/api/agents/tasks', {
        query: {},
        body: req.body,
      });
      res.status(result.status).json(result.body);
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  app.get('/api/agents/tasks', async (req, res) => {
    try {
      const result = await agentServer.handleRequest('GET', '/api/agents/tasks', {
        query: req.query,
        body: null,
      });
      res.status(result.status).json(result.body);
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  app.get('/api/agents/tasks/:taskId', async (req, res) => {
    try {
      const result = await agentServer.handleRequest('GET', `/api/agents/tasks/${req.params.taskId}`, {
        query: {},
        body: null,
      });
      res.status(result.status).json(result.body);
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  app.get('/api/agents/tasks/:taskId/status', async (req, res) => {
    try {
      const result = await agentServer.handleRequest('GET', `/api/agents/tasks/${req.params.taskId}/status`, {
        query: {},
        body: null,
      });
      res.status(result.status).json(result.body);
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  app.get('/api/agents/tasks/:taskId/result', async (req, res) => {
    try {
      const result = await agentServer.handleRequest('GET', `/api/agents/tasks/${req.params.taskId}/result`, {
        query: {},
        body: null,
      });
      res.status(result.status).json(result.body);
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  // 5. Storage'a bağlan ve server'ı başlat
  console.log('Connecting to storage...');
  await storage.connect();
  console.log('Storage connected!');

  app.listen(PORT, () => {
    console.log(`
🚀 Task System Demo running!

   API Server:  http://localhost:${PORT}
   Callbacks:   http://localhost:${CALLBACK_PORT}

📝 Test Commands:

1. Create a simple task:
   curl -X POST http://localhost:${PORT}/api/agents/tasks \\
     -H "Content-Type: application/json" \\
     -d '{"agentId": "task-processor", "input": "Hello World", "callbackUrl": "http://localhost:${CALLBACK_PORT}/callback"}'

2. Create a task without callback:
   curl -X POST http://localhost:${PORT}/api/agents/tasks \\
     -H "Content-Type: application/json" \\
     -d '{"agentId": "task-processor", "input": "Process this message"}'

3. List all tasks:
   curl http://localhost:${PORT}/api/agents/tasks

4. Get task status (replace TASK_ID):
   curl http://localhost:${PORT}/api/agents/tasks/TASK_ID/status

5. Get task result (replace TASK_ID):
   curl http://localhost:${PORT}/api/agents/tasks/TASK_ID/result

6. View callback results:
   curl http://localhost:${PORT}/callback-results

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
