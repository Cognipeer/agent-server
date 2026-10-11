import { describe, expect, it } from "vitest";
import { generateOpenAPISpec } from "../src/index.js";
import { memoryStorage } from "./helpers.js";

describe("OpenAPI spec", () => {
  it("documents the run routes and every $ref resolves", async () => {
    const spec = generateOpenAPISpec({ basePath: "/api", storage: await memoryStorage() }, []);
    for (const [path, method] of [
      ["/conversations/{conversationId}/cancel", "post"],
      ["/conversations/{conversationId}/events", "get"],
      ["/conversations/{conversationId}/events/stream", "get"],
      ["/tasks/{taskId}/cancel", "post"],
      ["/conversations/{conversationId}/files", "get"],
      ["/files", "post"],
    ] as const) {
      expect((spec.paths[path] as Record<string, unknown>)?.[method], `${method} ${path}`).toBeDefined();
    }

    const schemas = spec.components.schemas;
    const missing: string[] = [];
    const walk = (node: unknown) => {
      if (Array.isArray(node)) return node.forEach(walk);
      if (!node || typeof node !== "object") return;
      for (const [key, value] of Object.entries(node)) {
        if (key === "$ref" && typeof value === "string") {
          if (!(value.replace("#/components/schemas/", "") in schemas)) missing.push(value);
        } else walk(value);
      }
    };
    walk(spec.paths);
    walk(schemas);
    expect(missing).toEqual([]);

    expect(schemas.ConversationRuntime).toBeDefined();
    expect(schemas.WireEvent).toBeDefined();
    expect((schemas.Conversation as any).properties.runtime).toEqual({ $ref: "#/components/schemas/ConversationRuntime" });
    expect((schemas.Task as any).properties.status.enum).toContain("cancelled");
    expect((schemas.StreamDoneEvent as any).properties.seq).toBeDefined();
  });

  it("documents the files: raw upload, the listing, fileIds, ownership fields and what an agent accepts", async () => {
    const spec = generateOpenAPISpec({ basePath: "/api", storage: await memoryStorage() }, []);
    const upload = (spec.paths["/files"] as any).post;
    expect(Object.keys(upload.requestBody.content)).toEqual(expect.arrayContaining(["application/json", "application/octet-stream"]));
    expect(upload.parameters.map((p: any) => p.name)).toEqual(["name", "conversationId", "mimeType"]);
    expect(Object.keys(upload.responses)).toEqual(expect.arrayContaining(["201", "400", "403", "404", "409", "413", "415"]));
    expect((spec.paths["/files/{fileId}/content"] as any).get.parameters.map((p: any) => p.name)).toContain("disposition");

    const schemas = spec.components.schemas as Record<string, any>;
    expect(schemas.SendMessageRequest.properties.fileIds).toMatchObject({ type: "array" });
    expect(Object.keys(schemas.FileRecord.properties)).toEqual(expect.arrayContaining(["userId", "agentId", "expiresAt"]));
    expect(Object.keys(schemas.AttachmentsCapability.properties)).toEqual(
      expect.arrayContaining(["enabled", "maxFiles", "maxFileSize", "allowedMimeTypes", "acceptsImages"])
    );
    expect(schemas.Agent.properties.capabilities.properties.attachments).toEqual({ $ref: "#/components/schemas/AttachmentsCapability" });
    expect(schemas.ListFilesResponse.required).toContain("maxFiles");
  });
});
