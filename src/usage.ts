/**
 * Usage and spend: what a turn used, what it cost, and the budget rules.
 *
 * agent-sdk reports its usage as a ledger that grows over the life of a state: `perRequest` (one entry per model
 * call) and `totals` (per model: `input`, `output`, `total`, `cachedInput`). A turn that was paused and resumed
 * hands back the totals of the whole turn, pre-pause calls included. {@link normalizeUsage} turns that into what
 * ONE run used, by subtracting the ledger the run started from, so a resumed turn never counts the same tokens twice.
 */

import type { ModelPricing, PricingFn, SessionBudget, UsageInfo } from "./types.js";

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

const count = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

/** Rounds away float dust, so `0.1 + 0.2` reads `0.3`. */
export function roundUsd(value: number): number {
  return Math.round(value * 1e8) / 1e8;
}

/** The USD cost of some tokens of one model at `price`. */
export function priceTokens(
  price: ModelPricing,
  tokens: { input: number; output: number; cachedInput?: number }
): number {
  const cached = Math.min(count(tokens.cachedInput), tokens.input);
  const cachedPrice = price.cachedInputPerToken ?? price.inputPerToken;
  return (
    (tokens.input - cached) * price.inputPerToken + cached * cachedPrice + tokens.output * price.outputPerToken
  );
}

interface ModelTotals {
  input: number;
  output: number;
  total: number;
  cachedInput: number;
}

function readTotals(raw: unknown): Map<string, ModelTotals> {
  const out = new Map<string, ModelTotals>();
  const totals = isObject(raw) && isObject(raw.totals) ? raw.totals : undefined;
  for (const [model, entry] of Object.entries(totals ?? {})) {
    if (!isObject(entry)) continue;
    out.set(model, {
      input: count(entry.input),
      output: count(entry.output),
      total: count(entry.total),
      cachedInput: count(entry.cachedInput),
    });
  }
  return out;
}

export interface NormalizeUsageOptions {
  /**
   * The ledger the run started from (the `usage` of the SDK state it resumed). Its tokens are not this run's.
   * Absent for a run that starts fresh.
   */
  previous?: unknown;
  /** Prices the tokens (and sets `costUsd`). */
  pricing?: PricingFn;
  /** The model of a usage report that does not name one (Chat Completions, Responses, a handler). */
  model?: string;
}

/**
 * What a run used. Accepts agent-sdk's ledger (`{ perRequest, totals }`, cumulative) and the flat shape
 * (`{ inputTokens, outputTokens, totalTokens, cachedInputTokens?, costUsd?, model? }`) that the Chat Completions /
 * Responses providers and custom handlers report. Resolves `undefined` when there is nothing to report.
 * `costUsd` is present when at least one of the models used is priced.
 */
export function normalizeUsage(raw: unknown, options: NormalizeUsageOptions = {}): UsageInfo | undefined {
  if (!isObject(raw)) return undefined;
  const { pricing } = options;

  if (isObject(raw.totals)) {
    const now = readTotals(raw);
    // A ledger with nothing in it (a run that made no model call) reports nothing
    if (now.size === 0) return undefined;
    const before = readTotals(options.previous);
    let input = 0;
    let output = 0;
    let total = 0;
    let cached = 0;
    let cost = 0;
    let priced = false;
    for (const [model, used] of now) {
      const base = before.get(model);
      const delta = {
        input: Math.max(0, used.input - (base?.input ?? 0)),
        output: Math.max(0, used.output - (base?.output ?? 0)),
        total: Math.max(0, used.total - (base?.total ?? 0)),
        cachedInput: Math.max(0, used.cachedInput - (base?.cachedInput ?? 0)),
      };
      input += delta.input;
      output += delta.output;
      total += delta.total || delta.input + delta.output;
      cached += delta.cachedInput;
      const price = pricing?.(model);
      if (price) {
        priced = true;
        cost += priceTokens(price, delta);
      }
    }
    return {
      inputTokens: input,
      outputTokens: output,
      totalTokens: total,
      ...(cached > 0 ? { cachedInputTokens: cached } : {}),
      ...(priced ? { costUsd: roundUsd(cost) } : {}),
    };
  }

  // Flat: tokens as the provider or the handler counted them (not cumulative)
  const read = (...keys: string[]): number | undefined => {
    for (const key of keys) {
      const v = raw[key];
      if (typeof v === "number" && Number.isFinite(v)) return v;
    }
    return undefined;
  };
  const inputTokens = read("inputTokens", "input_tokens", "prompt_tokens");
  const outputTokens = read("outputTokens", "output_tokens", "completion_tokens");
  const totalTokens = read("totalTokens", "total_tokens");
  const cachedInputTokens = read("cachedInputTokens", "cached_input_tokens");
  let costUsd = read("costUsd", "cost_usd");
  if (inputTokens === undefined && outputTokens === undefined && totalTokens === undefined && costUsd === undefined) {
    return undefined;
  }
  if (costUsd === undefined && pricing) {
    const model = typeof raw.model === "string" ? raw.model : options.model;
    const price = model ? pricing(model) : undefined;
    if (price) {
      costUsd = roundUsd(
        priceTokens(price, { input: inputTokens ?? 0, output: outputTokens ?? 0, cachedInput: cachedInputTokens })
      );
    }
  }
  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(costUsd !== undefined ? { costUsd: roundUsd(costUsd) } : {}),
  };
}

/**
 * The part of an agent-sdk ledger a later `normalizeUsage` needs as its `previous`: a copy of the totals. Take it BEFORE the
 * agent runs - agent-sdk adds its calls to the ledger of the state it is given, in place, so a reference to it would
 * already include everything the run used and the run would look like it used nothing.
 */
export function snapshotLedger(ledger: unknown): { totals: Record<string, unknown> } | undefined {
  if (!isObject(ledger) || !isObject(ledger.totals)) return undefined;
  return { totals: JSON.parse(JSON.stringify(ledger.totals)) as Record<string, unknown> };
}

/** What a whole agent-sdk ledger cost (the cumulative usage of a state), at `pricing`. 0 when nothing is priced. */
export function ledgerCostUsd(ledger: unknown, pricing: PricingFn | undefined): number {
  if (!pricing || !isObject(ledger)) return 0;
  return normalizeUsage(ledger, { pricing })?.costUsd ?? 0;
}

/**
 * An agent-sdk `costEstimator` that prices with the same `pricing` function the server uses, so the SDK's own
 * `limits.maxCostUsd` stops a turn in the middle when the conversation's budget runs out. Pass it to
 * `createSmartAgent({ costEstimator })`. Without one the SDK cannot price a model call, its cost limit is a no-op, and
 * the budget applies between turns instead: the turn that crosses it completes, and the next one is refused.
 */
export function costEstimatorFromPricing(pricing: PricingFn) {
  return (args: {
    modelName?: string;
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens?: number;
  }): number => {
    const price = args.modelName ? pricing(args.modelName) : undefined;
    return price
      ? priceTokens(price, { input: args.inputTokens, output: args.outputTokens, cachedInput: args.cachedInputTokens })
      : 0;
  };
}

// ----------------------------------------------------------------------------
// Budgets
// ----------------------------------------------------------------------------

export type BudgetInput = { ok: true; budget: SessionBudget } | { ok: false; message: string };

/**
 * A budget as a request or a setting spells it (`maxCostUsd` / `max_cost_usd`, `onReach` / `on_reach`).
 * `onReach` defaults to `"pause"`: nothing is lost, the conversation waits.
 */
export function parseBudget(value: unknown, field = "budget"): BudgetInput {
  if (!isObject(value)) return { ok: false, message: `${field} must be an object: { maxCostUsd, onReach }` };
  const max = value.maxCostUsd ?? value.max_cost_usd;
  if (typeof max !== "number" || !Number.isFinite(max) || max <= 0) {
    return { ok: false, message: `${field}.maxCostUsd must be a number greater than 0` };
  }
  const onReach = value.onReach ?? value.on_reach ?? "pause";
  if (onReach !== "pause" && onReach !== "stop") {
    return { ok: false, message: `${field}.onReach must be "pause" or "stop"` };
  }
  return { ok: true, budget: { maxCostUsd: max, onReach } };
}

/** How `requested` compares with `current`: lowering a limit is the owner's to do, raising or removing it is not. */
export function budgetChangeKind(
  current: SessionBudget | null,
  requested: SessionBudget | null
): "same" | "lower" | "raise" {
  if (requested === null) return current === null ? "same" : "raise";
  if (current === null) return "lower";
  // "stop" ends the conversation, "pause" lets it be continued: pause is the looser of the two
  const looser = current.onReach === "stop" && requested.onReach === "pause";
  if (requested.maxCostUsd > current.maxCostUsd || looser) return "raise";
  return requested.maxCostUsd === current.maxCostUsd && requested.onReach === current.onReach ? "same" : "lower";
}

/** The SDK's wording of a cost-limit stop (`maxCostUsd ($x) exceeded ...`), reported as `detail`. */
export const isCostLimitDetail = (detail: unknown): boolean =>
  typeof detail === "string" && /^maxCostUsd\b/.test(detail);

/** How a budget is told to clients and in events: `{ max_cost_usd, on_reach }`. */
export const budgetWire = (budget: SessionBudget) => ({ max_cost_usd: budget.maxCostUsd, on_reach: budget.onReach });
