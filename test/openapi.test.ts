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
});
