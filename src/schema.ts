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

// ----------------------------------------------------------------------------
// JSON Schema for clients
// ----------------------------------------------------------------------------

/** A schema larger than this is not sent along with an action (it would swamp the pause it describes). */
const MAX_SCHEMA_BYTES = 32_000;
const MAX_SCHEMA_DEPTH = 12;

/**
 * The arguments of a tool as JSON Schema, for a client that lets a person edit them: a JSON Schema is passed on as it is, a zod
 * schema (v3 or v4) is converted. `undefined` when there is nothing usable (not a schema, or too large). Only the common shapes are
 * converted - strings, numbers, booleans, enums, literals, arrays, objects, unions, records, optional / nullable / default and the
 * wrappers around them; anything else becomes `{}` (any value) so the rest of the schema still helps.
 */
export function toJsonSchema(schema: unknown): Record<string, unknown> | undefined {
  if (!isObject(schema)) return undefined;
  try {
    const converted = typeof schema.safeParse === "function" ? fromZod(schema, 0) : schema;
    const json = JSON.parse(JSON.stringify(converted)) as unknown;
    if (!isObject(json)) return undefined;
    return JSON.stringify(json).length <= MAX_SCHEMA_BYTES ? json : undefined;
  } catch {
    return undefined;
  }
}

type ZodNode = Record<string, any>;

/** `ZodString` (v3) and `string` (v4) are the same kind: "string"; `ZodNativeEnum` is "nativeEnum". */
function zodKind(node: ZodNode): string {
  const def = (node._def ?? node._zod?.def) as ZodNode | undefined;
  const raw = typeof def?.typeName === "string" ? def.typeName.replace(/^Zod/, "") : typeof def?.type === "string" ? def.type : "";
  return raw.charAt(0).toLowerCase() + raw.slice(1);
}

const zodDef = (node: ZodNode): ZodNode => (node._def ?? node._zod?.def ?? {}) as ZodNode;

/** Whether an object property made of `node` may be left out. Structural: no schema code is run. */
function zodOptional(node: unknown, depth = 0): boolean {
  if (!isObject(node) || depth > MAX_SCHEMA_DEPTH) return false;
  const kind = zodKind(node);
  if (kind === "optional" || kind === "default" || kind === "prefault" || kind === "undefined" || kind === "any" || kind === "unknown") return true;
  const def = zodDef(node);
  const inner = def.innerType ?? def.schema ?? def.type ?? def.in;
  return ["nullable", "readonly", "branded", "catch", "effects", "pipeline", "pipe"].includes(kind) ? zodOptional(inner, depth + 1) : false;
}

function fromZod(node: unknown, depth: number): Record<string, unknown> {
  if (!isObject(node) || depth > MAX_SCHEMA_DEPTH) return {};
  const def = zodDef(node);
  const sub = (inner: unknown) => fromZod(inner, depth + 1);
  const describe = <T extends Record<string, unknown>>(out: T): T => {
    const description = typeof node.description === "string" ? node.description : typeof def.description === "string" ? def.description : undefined;
    return description ? ({ ...out, description } as T) : out;
  };
  const number = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : undefined);
  const kind = zodKind(node);

  switch (kind) {
    case "string": {
      const format =
        typeof node.format === "string" && ["email", "uuid", "date-time", "date", "time", "ipv4", "ipv6"].includes(node.format)
          ? node.format
          : node.format === "url"
            ? "uri"
            : node.isEmail
              ? "email"
              : node.isURL
                ? "uri"
                : node.isUUID
                  ? "uuid"
                  : node.isDatetime
                    ? "date-time"
                    : undefined;
      // (a regular expression the string must match: zod 3 keeps it in a `regex` check, zod 4 in the bag of patterns - which also holds
      // the one a known format implies, so it is read only where no format says it already)
      const regex =
        (Array.isArray(def.checks) ? (def.checks as Array<Record<string, any>>).find((check) => check?.kind === "regex")?.regex : undefined) ??
        [...((node._zod as { bag?: { patterns?: Set<RegExp> } } | undefined)?.bag?.patterns ?? [])][0];
      const pattern = !format && regex instanceof RegExp ? regex.source : undefined;
      return describe({
        type: "string",
        ...(number(node.minLength) !== undefined && { minLength: number(node.minLength) }),
        ...(number(node.maxLength) !== undefined && { maxLength: number(node.maxLength) }),
        ...(format && { format }),
        ...(pattern && { pattern }),
      });
    }
    case "number":
    case "int":
    case "bigint": {
      const integer = kind !== "number" || node.isInt === true || ["safeint", "int32", "uint32"].includes(def.format);
      // (zod 4 reports the safe-integer range as the bounds of every integer: that is no constraint of the tool's)
      const bound = (value: unknown) => {
        const n = number(value);
        return n !== undefined && Math.abs(n) < Number.MAX_SAFE_INTEGER ? n : undefined;
      };
      return describe({
        type: integer ? "integer" : "number",
        ...(bound(node.minValue) !== undefined && { minimum: bound(node.minValue) }),
        ...(bound(node.maxValue) !== undefined && { maximum: bound(node.maxValue) }),
      });
    }
    case "boolean":
      return describe({ type: "boolean" });
    case "null":
      return describe({ type: "null" });
    case "date":
      return describe({ type: "string", format: "date-time" });
    case "literal": {
      const values: unknown[] = Array.isArray(def.values) ? def.values : [def.value];
      return describe(values.length === 1 ? { const: values[0] } : { enum: values });
    }
    case "enum": {
      const values = Array.isArray(def.values) ? def.values : isObject(def.entries) ? Object.values(def.entries) : [];
      return describe({ type: "string", enum: values });
    }
    case "nativeEnum": {
      const source = isObject(def.values) ? def.values : {};
      // (a numeric enum is also mapped back from its numbers: those keys are not values)
      const values = Object.entries(source)
        .filter(([key]) => typeof source[source[key] as string] !== "number")
        .map(([, value]) => value);
      return describe({ enum: values });
    }
    case "array": {
      const exact = number(def.exactLength?.value);
      const min = exact ?? number(def.minLength?.value);
      const max = exact ?? number(def.maxLength?.value);
      return describe({
        type: "array",
        // (zod 3 keeps the element schema in `type`, zod 4 in `element` - and there `type` is the string "array")
        items: sub(def.element ?? def.type),
        ...(min !== undefined && { minItems: min }),
        ...(max !== undefined && { maxItems: max }),
      });
    }
    case "set":
      return describe({ type: "array", uniqueItems: true, items: sub(def.valueType) });
    case "tuple": {
      const items: unknown[] = Array.isArray(def.items) ? def.items : [];
      return describe({ type: "array", items: items.map(sub), minItems: items.length, maxItems: items.length });
    }
    case "object": {
      const shape = typeof def.shape === "function" ? def.shape() : def.shape;
      const properties: Record<string, unknown> = {};
      const required: string[] = [];
      for (const [key, value] of Object.entries(isObject(shape) ? shape : {})) {
        properties[key] = sub(value);
        if (!zodOptional(value)) required.push(key);
      }
      const unknownKeys = def.unknownKeys ?? (def.catchall && zodKind(def.catchall as ZodNode) === "never" ? "strict" : undefined);
      const catchall = isObject(def.catchall) && zodKind(def.catchall) !== "never" ? sub(def.catchall) : undefined;
      return describe({
        type: "object",
        properties,
        ...(required.length > 0 && { required }),
        ...(unknownKeys === "strict" && { additionalProperties: false }),
        ...(catchall && { additionalProperties: catchall }),
      });
    }
    case "record":
    case "map":
      return describe({ type: "object", additionalProperties: kind === "record" ? sub(def.valueType) : {} });
    case "union":
    case "discriminatedUnion": {
      const options: unknown[] = Array.isArray(def.options) ? def.options : def.options instanceof Map ? [...def.options.values()] : [];
      return describe({ anyOf: options.map(sub) });
    }
    case "intersection":
      return describe({ allOf: [sub(def.left), sub(def.right)] });
    case "nullable":
      return describe({ anyOf: [sub(def.innerType), { type: "null" }] });
    case "optional":
    case "nonoptional":
    case "readonly":
    case "catch":
      return describe({ ...sub(def.innerType) });
    case "default":
    case "prefault": {
      const fallback = typeof def.defaultValue === "function" ? safely(() => def.defaultValue()) : def.defaultValue;
      return describe({ ...sub(def.innerType), ...(fallback !== undefined && { default: fallback }) });
    }
    case "branded":
      return describe({ ...sub(def.type) });
    case "effects":
      return describe({ ...sub(def.schema) });
    case "pipeline":
    case "pipe":
      return describe({ ...sub(def.in) });
    case "lazy":
      return describe({ ...sub(safely(() => def.getter())) });
    default:
      return describe({});
  }
}

function safely<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch {
    return undefined;
  }
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
