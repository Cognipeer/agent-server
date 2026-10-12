/**
 * Helpers of the files tests: a few agents, a server to put them behind, and the calls a client makes.
 */

import { createAgentServer } from "../src/index.js";
import type {
  AgentFilesConfig,
  AgentHandler,
  AgentRegistration,
  AgentServerConfig,
  FilesConfig,
  StorageProvider,
} from "../src/index.js";
import { expect } from "vitest";

// A 1x1 PNG
export const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
  "base64"
);
export const b64 = (text: string | Buffer) => Buffer.from(text).toString("base64");

// ----------------------------------------------------------------------------
// Agents
// ----------------------------------------------------------------------------

export interface Call {
  messages: any[];
  input: any;
}

/** An agent-sdk-shaped agent that records what it is given. `runtime` is what `__runtime` says (absent: the instance says nothing). */
export function recordingAgent(
  options: {
    runtime?: { tools?: string[]; model?: unknown };
    run?: (input: any, config: any) => Promise<void> | void;
    answer?: string;
  } = {}
) {
  const calls: Call[] = [];
  const agent: any = {
    calls,
    invoke: async (input: any, config: any) => {
      calls.push({ messages: input.messages ?? [], input });
      await options.run?.(input, config);
      return { content: options.answer ?? "ok", messages: [], metadata: {}, state: { messages: input.messages ?? [] } };
    },
  };
  if (options.runtime) {
    agent.__runtime = { tools: (options.runtime.tools ?? []).map((name) => ({ name })), model: options.runtime.model };
  }
  return agent;
}

/** What the model was told in the last user turn. */
export const lastUser = (agent: { calls: Call[] }, call = -1) => {
  const messages = agent.calls.at(call)!.messages.filter((m: any) => m.role === "user");
  return messages.at(-1);
};
export const textOf = (content: unknown): string =>
  typeof content === "string"
    ? content
    : (content as any[]).filter((p) => p.type === "text").map((p) => p.text).join("\n");

// ----------------------------------------------------------------------------
// Boot
// ----------------------------------------------------------------------------

export interface Boot {
  agent?: unknown;
  handler?: AgentHandler;
  files?: FilesConfig;
  agentFiles?: AgentFilesConfig;
  /** Identities by the `x-user` header (a request without one is refused). */
  identity?: boolean;
  config?: Partial<AgentServerConfig>;
  storage?: StorageProvider;
}

export async function boot(o: Boot & { storage: StorageProvider }) {
  const storage = o.storage;
  const registration: AgentRegistration = {
    info: { id: "a", name: "A" },
    ...(o.handler ? { handler: o.handler } : { sdkAgent: o.agent ?? recordingAgent() }),
    ...(o.agentFiles ? { files: o.agentFiles } : {}),
  };
  const server = createAgentServer({
    basePath: "/api",
    storage,
    agents: [registration],
    ...(o.files ? { files: o.files } : {}),
    runs: { sweepIntervalMs: 0, recoverOnStart: false },
    ...(o.identity
      ? {
          resolveContext: (req) => {
            const user = req.headers["x-user"];
            return user ? { user: { id: String(user) }, data: {} } : null;
          },
        }
      : {}),
    ...o.config,
  });
  type Extra = { body?: unknown; query?: Record<string, string>; headers?: Record<string, string>; user?: string };
  const call = (method: string, path: string, extra: Extra = {}) =>
    server.handleRoute(method, path, {
      query: extra.query ?? {},
      body: extra.body,
      headers: { ...(extra.user ? { "x-user": extra.user } : {}), ...(extra.headers ?? {}) },
    });
  const conversation = async (user?: string) =>
    ((await call("POST", "/conversations", { body: { agentId: "a" }, user })).body as any).conversation.id as string;

  /** A raw upload: the file's bytes, its own type, the name in the query. */
  const uploadRaw = (conversationId: string | undefined, name: string, bytes: Buffer | string, type = "text/plain", user?: string) =>
    call("POST", "/files", {
      body: Buffer.from(bytes),
      headers: { "content-type": type },
      query: { name, ...(conversationId ? { conversationId } : {}) },
      user,
    });
  /** The JSON upload every client has used. */
  const uploadJson = (conversationId: string | undefined, name: string, text: string | Buffer, mimeType = "text/plain", user?: string) =>
    call("POST", "/files", { body: { file: { name, content: b64(text), mimeType }, conversationId }, user });
  const fileOf = async (res: Promise<any> | any) => {
    const r = await res;
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return (r.body as any).file as { id: string; name: string; mimeType: string; size: number };
  };
  const send = (id: string, message: string, extra: Record<string, unknown> = {}, user?: string) =>
    call("POST", `/conversations/${id}/messages`, { body: { message, ...extra }, user });
  const messages = async (id: string, user?: string) => ((await call("GET", `/conversations/${id}`, { user })).body as any).messages as any[];
  return { server, storage, call, conversation, uploadRaw, uploadJson, fileOf, send, messages };
}

export const errorOf = (res: { body?: unknown }) => (res.body as any).error as { code: string; message: string; details?: any };

