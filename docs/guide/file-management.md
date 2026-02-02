# File Management

Built-in file upload and management for AI agents.

## Overview

The agent server provides complete file management:

- **Upload** - Upload files via REST API
- **Download** - Download files or view metadata
- **Attach** - Attach files to messages
- **Storage** - Files stored in configured provider

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | /files | Upload a file |
| GET | /files/:fileId | Get file metadata |
| GET | /files/:fileId/content | Download file content |
| DELETE | /files/:fileId | Delete a file |

## Uploading Files

### Using multipart/form-data

```typescript
const formData = new FormData();
formData.append('file', fileInput.files[0]);

const response = await fetch('/api/agents/files', {
  method: 'POST',
  headers: {
    'Authorization': 'Bearer your-token',
  },
  body: formData,
});

const { file } = await response.json();
console.log('Uploaded:', file.id, file.name);
```

### Response

```json
{
  "file": {
    "id": "file_abc123",
    "name": "document.pdf",
    "mimeType": "application/pdf",
    "size": 12345,
    "url": "/api/agents/files/file_abc123/content",
    "createdAt": "2025-01-01T00:00:00.000Z"
  }
}
```

## Attaching Files to Messages

When sending a message, include file IDs:

```typescript
const response = await fetch('/api/agents/conversations/conv-123/messages', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer your-token',
  },
  body: JSON.stringify({
    message: 'Please analyze this document',
    files: ['file_abc123', 'file_def456'],
  }),
});
```

## Downloading Files

### Get Metadata

```bash
GET /api/agents/files/file_abc123
```

Response:
```json
{
  "id": "file_abc123",
  "name": "document.pdf",
  "mimeType": "application/pdf",
  "size": 12345,
  "createdAt": "2025-01-01T00:00:00.000Z"
}
```

### Download Content

```bash
GET /api/agents/files/file_abc123/content
```

Returns the raw file content with appropriate `Content-Type` header.

## File Storage

Files are stored using the configured storage provider:

### PostgreSQL

Files are stored in the `agent_server_files` table with content as `BYTEA`.

### MongoDB

Files are stored in the `agent_server_files` collection with content as `Buffer`.

### Custom Storage

For large files, consider using external storage (S3, GCS) and storing only references:

```typescript
class S3StorageProvider extends BaseStorageProvider {
  private s3: S3Client;

  async saveFile(params: SaveFileParams): Promise<FileRecord> {
    const key = `files/${generateId()}`;
    
    // Upload to S3
    await this.s3.send(new PutObjectCommand({
      Bucket: 'my-bucket',
      Key: key,
      Body: params.content,
      ContentType: params.mimeType,
    }));
    
    // Save metadata to database (without content)
    const file = {
      id: generateId(),
      name: params.name,
      mimeType: params.mimeType,
      size: params.size,
      storageKey: key,  // Store S3 key instead of content
      createdAt: new Date(),
    };
    
    await this.db.files.insert(file);
    return file;
  }

  async getFileContent(id: string): Promise<Buffer | null> {
    const file = await this.getFile(id);
    if (!file?.storageKey) return null;
    
    // Download from S3
    const response = await this.s3.send(new GetObjectCommand({
      Bucket: 'my-bucket',
      Key: file.storageKey,
    }));
    
    return Buffer.from(await response.Body.transformToByteArray());
  }
}
```

## File Validation

Implement file validation in your upload handling:

```typescript
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const ALLOWED_TYPES = ['image/png', 'image/jpeg', 'application/pdf'];

agentServer.registerCustomAgent('document-analyzer', {
  processMessage: async ({ message, files }) => {
    if (files) {
      for (const file of files) {
        if (file.size > MAX_FILE_SIZE) {
          return { content: `File ${file.name} is too large. Max size is 10MB.` };
        }
        if (!ALLOWED_TYPES.includes(file.mimeType)) {
          return { content: `File type ${file.mimeType} is not supported.` };
        }
      }
    }
    
    // Process files...
    return { content: 'Files processed successfully.' };
  },
});
```

## AI File Access

When an AI agent processes a message with files, it receives file metadata:

```typescript
interface FileAttachment {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  url?: string;       // URL to download content
  storageKey?: string; // Internal storage key
}

// In your agent handler
agentServer.registerCustomAgent('file-processor', {
  processMessage: async ({ message, files, storage }) => {
    if (files && files.length > 0) {
      for (const file of files) {
        // Get file content
        const content = await storage.getFileContent(file.id);
        
        // Process based on type
        if (file.mimeType === 'application/pdf') {
          const text = await extractPDFText(content);
          // ...
        }
      }
    }
    
    return { content: 'Processed files' };
  },
});
```

## Agent-Generated Files

Agents can also create files in their responses:

```typescript
agentServer.registerCustomAgent('chart-generator', {
  processMessage: async ({ message }) => {
    // Generate a chart
    const chartBuffer = await generateChart(message);
    
    // Save the file
    const file = await storage.saveFile({
      name: 'chart.png',
      mimeType: 'image/png',
      size: chartBuffer.length,
      content: chartBuffer,
    });
    
    return {
      content: 'Here is your chart:',
      files: [{
        id: file.id,
        name: file.name,
        mimeType: file.mimeType,
        size: file.size,
        url: `/api/agents/files/${file.id}/content`,
      }],
    };
  },
});
```

## Client Integration

Using with `@cognipeer/chat-ui`:

```tsx
import { Chat } from '@cognipeer/chat-ui';

<Chat
  baseUrl="/api/agents"
  agentId="document-analyzer"
  enableFileUpload={true}
  allowedFileTypes={['image/*', '.pdf', '.txt']}
  maxFileSize={10 * 1024 * 1024}
  maxFiles={5}
/>
```

## Security Considerations

1. **Validate file types** - Don't trust `Content-Type`, validate file content
2. **Limit file size** - Prevent DoS attacks with large uploads
3. **Scan for malware** - Use antivirus scanning for uploaded files
4. **Access control** - Ensure users can only access their own files
5. **Secure storage** - Use encrypted storage for sensitive files

## Next Steps

- [Streaming](/guide/streaming)
- [Custom Agents](/guide/custom-agents)
- [Error Handling](/guide/error-handling)
