/**
 * Checks the arguments a person edited an approval to against the schema of the tool they will be passed to.
 *
 * agent-sdk tools describe their arguments with a zod schema (`tool.schema`); tools that come from MCP or other
 * runtimes carry a JSON Schema (`parameters`, `inputSchema`, ...). Both are understood; a keyword this file does not
 * know is not checked (the check refuses what is plainly wrong, it does not try to be a full validator).
 */

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Where an agent-sdk tool keeps the description of its arguments, in the order they are tried. */
const SCHEMA_KEYS = ["schema", "parameters", "inputSchema", "input_schema", "jsonSchema"] as const;

/** The schema of a tool of an agent-sdk agent, or `undefined` when the agent does not say. */
export function findToolSchema(sdkAgent: unknown, toolName: string): unknown {
  const tools = (sdkAgent as { __runtime?: { tools?: unknown } } | undefined)?.__runtime?.tools;
  if (!Array.isArray(tools)) return undefined;
  const tool = tools.find((t) => isObject(t) && t.name === toolName);
  if (!isObject(tool)) return undefined;
  for (const key of SCHEMA_KEYS) {
    if (tool[key] !== undefined && tool[key] !== null) return tool[key];
  }
  return undefined;
}

/** `null` when `value` fits `schema`, else a sentence saying what does not. Anything that is not a known schema accepts. */
export function validateAgainstSchema(schema: unknown, value: unknown): string | null {
  if (!isObject(schema)) return null;

  // zod (v3 and v4): safeParse
  if (typeof schema.safeParse === "function") {
    const result = (schema.safeParse as (v: unknown) => unknown)(value) as {
      success?: boolean;
      error?: { issues?: Array<{ path?: unknown[]; message?: string }>; message?: string };
    };
    if (result?.success !== false) return null;
    const issues = result.error?.issues ?? [];
    if (issues.length === 0) return result.error?.message ?? "does not match the tool's schema";
    return issues
      .slice(0, 5)
      .map((issue) => `${issue.path?.length ? issue.path.join(".") : "(arguments)"}: ${issue.message ?? "invalid"}`)
      .join("; ");
  }

  const errors: string[] = [];
  checkJsonSchema(schema, value, "(arguments)", errors, 0);
  return errors.length > 0 ? errors.slice(0, 5).join("; ") : null;
}

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function matchesType(type: string, value: unknown): boolean {
  switch (type) {
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "object":
      return isObject(value);
    default:
      return typeOf(value) === type;
  }
}

function checkJsonSchema(schema: Record<string, unknown>, value: unknown, path: string, errors: string[], depth: number): void {
  if (depth > 12) return;
  const fail = (message: string): void => {
    errors.push(`${path}: ${message}`);
  };

  if (Array.isArray(schema.allOf)) {
    for (const part of schema.allOf) if (isObject(part)) checkJsonSchema(part, value, path, errors, depth + 1);
  }
  for (const key of ["anyOf", "oneOf"] as const) {
    const options = schema[key];
    if (!Array.isArray(options) || options.length === 0) continue;
    const results = options.filter(isObject).map((option) => {
      const inner: string[] = [];
      checkJsonSchema(option, value, path, inner, depth + 1);
      return inner;
    });
    const passing = results.filter((inner) => inner.length === 0).length;
    if (passing === 0 || (key === "oneOf" && passing > 1)) {
      fail(passing === 0 ? `does not match any of the allowed shapes` : `matches more than one of the allowed shapes`);
    }
  }

  if (schema.const !== undefined && JSON.stringify(schema.const) !== JSON.stringify(value)) {
    return fail(`must be ${JSON.stringify(schema.const)}`);
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((option) => JSON.stringify(option) === JSON.stringify(value))) {
    return fail(`must be one of ${schema.enum.map((option) => JSON.stringify(option)).join(", ")}`);
  }

  const types = typeof schema.type === "string" ? [schema.type] : Array.isArray(schema.type) ? schema.type : undefined;
  if (types && !types.some((type) => typeof type === "string" && matchesType(type, value))) {
    return fail(`must be ${types.join(" or ")}, not ${typeOf(value)}`);
  }

  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) fail(`must be at least ${schema.minLength} characters`);
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) fail(`must be at most ${schema.maxLength} characters`);
    if (typeof schema.pattern === "string") {
      try {
        if (!new RegExp(schema.pattern).test(value)) fail(`must match ${schema.pattern}`);
      } catch {
        // a pattern this engine cannot read is not checked
      }
    }
  }
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) fail(`must be at least ${schema.minimum}`);
    if (typeof schema.maximum === "number" && value > schema.maximum) fail(`must be at most ${schema.maximum}`);
    if (typeof schema.exclusiveMinimum === "number" && value <= schema.exclusiveMinimum) fail(`must be above ${schema.exclusiveMinimum}`);
    if (typeof schema.exclusiveMaximum === "number" && value >= schema.exclusiveMaximum) fail(`must be below ${schema.exclusiveMaximum}`);
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) fail(`must have at least ${schema.minItems} items`);
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) fail(`must have at most ${schema.maxItems} items`);
    if (isObject(schema.items)) {
      value.forEach((item, index) => checkJsonSchema(schema.items as Record<string, unknown>, item, `${path}[${index}]`, errors, depth + 1));
    }
  }
  if (isObject(value)) {
    const properties = isObject(schema.properties) ? schema.properties : {};
    if (Array.isArray(schema.required)) {
      for (const name of schema.required) {
        if (typeof name === "string" && !(name in value)) errors.push(`${path}.${name}: is required`);
      }
    }
    for (const [name, inner] of Object.entries(value)) {
      const known = properties[name];
      if (isObject(known)) checkJsonSchema(known, inner, `${path}.${name}`, errors, depth + 1);
      else if (schema.additionalProperties === false && !(name in properties)) errors.push(`${path}.${name}: is not allowed`);
      else if (isObject(schema.additionalProperties) && !(name in properties)) {
        checkJsonSchema(schema.additionalProperties, inner, `${path}.${name}`, errors, depth + 1);
      }
    }
  }
}
