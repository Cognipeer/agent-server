/**
 * The API, its OpenAPI spec and its documentation say the same thing: every route is in the spec and in the endpoint reference, every
 * error code the server answers with is in the catalogue and in the error guide, every server option is described. A new route or code
 * that is not written down fails here instead of drifting.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createAgentServer, createInMemoryProvider, generateOpenAPISpec } from "../src/index.js";
import { ERROR_CODES } from "../src/swagger.js";

const root = path.join(__dirname, "..");
const read = (file: string) => readFileSync(path.join(root, file), "utf8");

function sourceFiles(dir: string): string[] {
  return readdirSync(path.join(root, dir)).flatMap((name) => {
    const rel = path.join(dir, name);
    return statSync(path.join(root, rel)).isDirectory() ? sourceFiles(rel) : rel.endsWith(".ts") ? [rel] : [];
  });
}

const server = createAgentServer({ basePath: "/api", storage: createInMemoryProvider(), swagger: { enabled: true } });
// (the documentation routes are not part of the API)
const routes = server.getRoutes().filter((route) => !route.path.startsWith("/docs"));
const spec = generateOpenAPISpec({ basePath: "/api", storage: createInMemoryProvider() }, []);

/** `/conversations/:conversationId/files/:tool*` -> `/conversations/{conversationId}/files/{tool}` */
const openApiPath = (route: string) => route.replace(/:([A-Za-z]+)\*?/g, "{$1}");
/** The shape of a path, whatever its parameters are called: `/conversations/:/messages` */
const skeleton = (route: string) => route.replace(/(:|\{)[A-Za-z]+\*?\}?/g, ":");

describe("routes", () => {
  it("has every route of the server in the OpenAPI spec, and no operation without a route", () => {
    const documented = new Set<string>();
    for (const [route, operations] of Object.entries(spec.paths as Record<string, Record<string, unknown>>)) {
      for (const method of Object.keys(operations)) documented.add(`${method.toUpperCase()} ${route}`);
    }
    const served = new Set(routes.map((route) => `${route.method} ${openApiPath(route.path)}`));
    expect([...served].filter((key) => !documented.has(key))).toEqual([]);
    expect([...documented].filter((key) => !served.has(key))).toEqual([]);
  });

  it("has every route in the endpoint reference", () => {
    const text = read("docs/api/endpoints.md");
    const documented = new Set(
      [...text.matchAll(/^(GET|POST|PATCH|DELETE)\s+(\/[^\s?]*)/gm)].map((match) => `${match[1]} ${skeleton(match[2]!)}`)
    );
    const missing = routes.map((route) => `${route.method} ${skeleton(route.path)}`).filter((key) => !documented.has(key));
    expect(missing).toEqual([]);
  });
});

describe("error codes", () => {
  // Codes that are not an HTTP answer: they come in events and warnings, or from a driver
  const notHttp = new Set([
    "run_interrupted", // the session.error event of a run the server lost
    "pause_state_too_large", // a warning on a turn
    "file_truncated",
    "file_unreadable",
    "images_not_supported",
    "ERR_OUT_OF_RANGE", // a driver's own
  ]);

  it("lists every code the server answers with", () => {
    const used = new Set<string>();
    for (const file of sourceFiles("src")) {
      if (file.endsWith("swagger.ts")) continue;
      for (const match of read(file).matchAll(/\bcode: "([A-Za-z_]+)"/g)) used.add(match[1]!);
      for (const match of read(file).matchAll(/super\([^,]+,\s*"([A-Za-z_]+)",\s*\d{3}/g)) used.add(match[1]!);
    }
    const catalogued = new Set(ERROR_CODES.map((entry) => entry.code));
    expect([...used].filter((code) => !notHttp.has(code) && !catalogued.has(code))).toEqual([]);
    expect([...catalogued].filter((code) => !used.has(code))).toEqual([]);
  });

  it("explains each one in the error guide and in the OpenAPI Error schema", () => {
    const guide = read("docs/guide/error-handling.md");
    const description = (spec.components.schemas.Error as any).properties.error.properties.code.description as string;
    for (const { code } of ERROR_CODES) {
      expect(guide, `${code} in docs/guide/error-handling.md`).toContain(`\`${code}\``);
      expect(description, `${code} in the Error schema`).toContain(`\`${code}\``);
    }
  });
});

describe("server options", () => {
  it("describes every AgentServerConfig option in the server reference", () => {
    const types = read("src/types.ts");
    const block = types.slice(types.indexOf("export interface AgentServerConfig {"));
    const body = block.slice(0, block.indexOf("\n}\n"));
    const options = [...body.matchAll(/^ {2}([A-Za-z]+)\??:/gm)].map((match) => match[1]!);
    expect(options.length).toBeGreaterThan(15);
    const reference = read("docs/api/server.md");
    expect(options.filter((option) => !new RegExp(`\\b${option}\\b`).test(reference))).toEqual([]);
  });

  it("documents the registration and route methods of the server", () => {
    const reference = read("docs/api/server.md");
    for (const method of ["registerSDKAgent", "registerCustomAgent", "registerHostAgent", "registerChatCompletionsAgent", "registerResponsesAgent", "getRoutes", "expirePendingActions", "recoverStaleRuns", "purgeExpiredFiles"]) {
      expect(reference, method).toContain(method);
    }
  });
});

describe("links", () => {
  function markdownFiles(dir: string): string[] {
    return readdirSync(path.join(root, dir)).flatMap((name) => {
      const rel = path.join(dir, name);
      if (name === ".vitepress" || name === "node_modules") return [];
      return statSync(path.join(root, rel)).isDirectory() ? markdownFiles(rel) : rel.endsWith(".md") ? [rel] : [];
    });
  }

  it("points every link in the documentation at a page that exists", () => {
    const broken: string[] = [];
    for (const file of [...markdownFiles("docs"), "README.md"]) {
      const text = read(file).replace(/```[\s\S]*?```/g, "");
      for (const match of text.matchAll(/\]\(([^)\s]+)\)/g)) {
        const link = match[1]!;
        if (/^(https?:|mailto:|#)/.test(link)) continue;
        const target = link.split("#")[0]!;
        if (!target) continue;
        const candidates = target.startsWith("/")
          ? [path.join("docs", `${target}.md`), path.join("docs", target, "index.md"), path.join("docs", target)]
          : [path.normalize(path.join(path.dirname(file), target)), `${path.normalize(path.join(path.dirname(file), target))}.md`, path.join(path.normalize(path.join(path.dirname(file), target)), "index.md")];
        if (!candidates.some((candidate) => existsSync(path.join(root, candidate)))) broken.push(`${file} -> ${link}`);
      }
    }
    expect(broken).toEqual([]);
  });
});
