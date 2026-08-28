import { describe, expect, it } from "vitest";
import {
  createAgentServer,
  createInMemoryProvider,
} from "../src/index.js";

describe("package entrypoint", () => {
  it("creates a server with an in-memory storage provider", () => {
    const storage = createInMemoryProvider();
    const server = createAgentServer({
      basePath: "/api/agents",
      storage,
    });

    expect(server.getBasePath()).toBe("/api/agents");
    expect(server.getConfig().storage).toBe(storage);
  });
});