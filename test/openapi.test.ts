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
      expect.arrayContaining(["enabled", "maxFiles", "maxFileSize", "allowedMimeTypes", "acceptsImages", "retentionDays"])
    );
    expect(schemas.Agent.properties.capabilities.properties.attachments).toEqual({ $ref: "#/components/schemas/AttachmentsCapability" });
    expect(schemas.ListFilesResponse.required).toContain("maxFiles");
  });

  it("documents approvals that lapse, who may answer, budgets, continue and remembered tools", async () => {
    const spec = generateOpenAPISpec({ basePath: "/api", storage: await memoryStorage() }, []);
    for (const [path, method] of [
      ["/conversations/{conversationId}/continue", "post"],
      ["/conversations/{conversationId}/remembered-tools", "get"],
      ["/conversations/{conversationId}/remembered-tools/{tool}", "delete"],
      ["/conversations/{conversationId}", "patch"],
    ] as const) {
      expect((spec.paths[path] as Record<string, unknown>)?.[method], `${method} ${path}`).toBeDefined();
    }
    const paths = spec.paths as Record<string, any>;
    expect(Object.keys(paths["/conversations/{conversationId}/actions/{actionId}"].post.responses)).toEqual(
      expect.arrayContaining(["200", "400", "402", "403", "404", "409", "410"])
    );
    expect(Object.keys(paths["/conversations/{conversationId}/messages"].post.responses)).toContain("402");
    expect(paths["/conversations/{conversationId}"].patch.requestBody.content["application/json"].schema).toEqual({
      $ref: "#/components/schemas/UpdateConversationRequest",
    });

    const schemas = spec.components.schemas as Record<string, any>;
    expect(Object.keys(schemas.Conversation.properties)).toEqual(expect.arrayContaining(["budget", "spentUsd", "rememberedTools"]));
    expect(schemas.SessionBudget.properties.onReach.enum).toEqual(["pause", "stop"]);
    expect(Object.keys(schemas.UsageInfo.properties)).toEqual(expect.arrayContaining(["cachedInputTokens", "costUsd"]));
    expect(schemas.SendMessageResponse.properties.usage).toEqual({ $ref: "#/components/schemas/UsageInfo" });
    expect(schemas.SendMessageResponse.properties.spentUsd).toBeDefined();
    expect(schemas.CreateConversationRequest.properties.budget).toBeDefined();
    expect(schemas.PendingAction.properties.questions.items.properties.options.items.properties.preview).toBeDefined();
    expect(schemas.ActionSnapshot.properties.status.enum).toEqual(["pending", "resolved", "cancelled", "expired"]);
    expect(schemas.StreamActionResolvedEvent.properties.resolution.properties.expired).toBeDefined();
  });

  it("documents what a client reattaching to a run needs: the snapshot frame, the failure in the runtime, the schema of an approval's arguments", async () => {
    const spec = generateOpenAPISpec({ basePath: "/api", storage: await memoryStorage() }, []);
    const stream = (spec.paths["/conversations/{conversationId}/events/stream"] as any).get;
    expect(stream.description).toContain("agent.message.snapshot");
    expect(stream.description).toContain("user_message");

    const schemas = spec.components.schemas as Record<string, any>;
    expect(schemas.ConversationRuntime.properties.error).toMatchObject({ type: "object", required: ["code", "message"] });
    expect(schemas.ConversationRuntime.properties.error.description).toContain("run_interrupted");
    expect(schemas.PendingAction.properties.argsSchema).toMatchObject({ type: "object" });
  });
});
