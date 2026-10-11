/**
 * The real agent-sdk for the tests that need one (see vitest.config.ts for where it comes from). `sdk` is undefined when there is none,
 * and those tests are skipped.
 */

export const hasSdk = process.env.AGENT_SDK_AVAILABLE === "1";

export const sdk: any = hasSdk ? await import("@cognipeer/agent-sdk") : undefined;

/**
 * Whether the SDK hangs up on the model when a run is cancelled (agent-sdk 0.10.6: the abort signal reaches `fetch`, and the run ends
 * with `ctx.__cancelled`). `describeContentPart` was exported by the same release.
 */
export const sdkAbortsRequests = typeof sdk?.describeContentPart === "function";
