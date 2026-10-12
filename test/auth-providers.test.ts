/**
 * The built-in auth providers: the JWT provider verifies the signature with the key it is configured with (and nothing the token says
 * about itself decides how), and the token provider's generated tokens cannot be guessed.
 */

import { createHmac, createSign, generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentServer, createInMemoryProvider, createJWTAuthProvider, createTokenAuthProvider } from "../src/index.js";

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const now = () => Math.floor(Date.now() / 1000);

/** A compact JWS signed with an HMAC. */
function hs(secret: string, payload: Record<string, unknown>, alg = "HS256", header: Record<string, unknown> = {}) {
  const hash = { HS256: "sha256", HS384: "sha384", HS512: "sha512" }[alg as "HS256"] ?? "sha256";
  const head = b64({ alg, typ: "JWT", ...header });
  const body = b64(payload);
  return `${head}.${body}.${createHmac(hash, secret).update(`${head}.${body}`).digest("base64url")}`;
}

const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
const rsaPublicPem = rsa.publicKey.export({ type: "spki", format: "pem" }).toString();
function rs(payload: Record<string, unknown>, alg = "RS256", privateKey = rsa.privateKey) {
  const head = b64({ alg, typ: "JWT" });
  const body = b64(payload);
  const hash = { RS256: "RSA-SHA256", RS384: "RSA-SHA384", RS512: "RSA-SHA512" }[alg as "RS256"] ?? "RSA-SHA256";
  return `${head}.${body}.${createSign(hash).update(`${head}.${body}`).sign(privateKey).toString("base64url")}`;
}

const ec = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const ecPublicPem = ec.publicKey.export({ type: "spki", format: "pem" }).toString();
function es(payload: Record<string, unknown>, privateKey = ec.privateKey) {
  const head = b64({ alg: "ES256", typ: "JWT" });
  const body = b64(payload);
  const signature = cryptoSign("sha256", Buffer.from(`${head}.${body}`), { key: privateKey, dsaEncoding: "ieee-p1363" });
  return `${head}.${body}.${signature.toString("base64url")}`;
}

describe("JWTAuthProvider", () => {
  const secret = "a-shared-secret";
  const claims = (extra: Record<string, unknown> = {}) => ({ sub: "alice", exp: now() + 600, ...extra });
  const provider = (config: Record<string, unknown> = {}) => createJWTAuthProvider({ secret, ...config });

  describe("signature", () => {
    it("accepts a token signed with the secret and hands over the user and the claims", async () => {
      const result = await provider().validateToken(hs(secret, claims({ role: "admin" })));
      expect(result).toMatchObject({ valid: true, userId: "alice" });
      expect(result.metadata).toMatchObject({ sub: "alice", role: "admin" });
    });

    it("refuses a token signed with another secret, a garbage signature and a changed payload", async () => {
      expect(await provider().validateToken(hs("not-the-secret", claims()))).toMatchObject({ valid: false, error: "Invalid signature" });

      const good = hs(secret, claims());
      const [head, , signature] = good.split(".");
      expect(await provider().validateToken(`${head}.${b64(claims({ sub: "victim-admin" }))}.${signature}`)).toMatchObject({ valid: false });
      expect(await provider().validateToken(`${head}.${b64(claims({ sub: "victim-admin" }))}.AAAA`)).toMatchObject({ valid: false });
      expect(await provider().validateToken(`${good.slice(0, -4)}AAAA`)).toMatchObject({ valid: false });
    });

    it("refuses alg none, with an empty or a made-up signature", async () => {
      const header = b64({ alg: "none", typ: "JWT" });
      const body = b64(claims());
      for (const token of [`${header}.${body}.`, `${header}.${body}.AAAA`, `${header}.${body}`]) {
        expect(await provider().validateToken(token), token).toMatchObject({ valid: false });
      }
      // the same with the casing tricks
      for (const alg of ["None", "NONE", "nOnE"]) {
        expect(await provider().validateToken(`${b64({ alg })}.${body}.`)).toMatchObject({ valid: false });
      }
    });

    it("takes the algorithm from the configuration, not from the token", async () => {
      // an HS384 token, however well signed, is not an HS256 one
      expect(await provider().validateToken(hs(secret, claims(), "HS384"))).toMatchObject({ valid: false, error: "Unsupported algorithm" });
      expect(await provider({ algorithm: "HS384" }).validateToken(hs(secret, claims(), "HS384"))).toMatchObject({ valid: true });
      expect(await provider({ algorithm: "HS512" }).validateToken(hs(secret, claims(), "HS512"))).toMatchObject({ valid: true });
      // a header that names an extension the provider does not know
      expect(await provider().validateToken(hs(secret, claims(), "HS256", { crit: ["x"], x: 1 }))).toMatchObject({ valid: false });
    });

    it("does not let a public key be used as an HMAC secret (RS to HS confusion)", async () => {
      const verifier = createJWTAuthProvider({ secret: rsaPublicPem, algorithm: "RS256" });
      expect(await verifier.validateToken(rs(claims()))).toMatchObject({ valid: true, userId: "alice" });
      // the attacker signs with HS256, using the public key as the secret
      expect(await verifier.validateToken(hs(rsaPublicPem, claims()))).toMatchObject({ valid: false });
      // and an RS256-labelled token whose signature is an HMAC
      const head = b64({ alg: "RS256" });
      const body = b64(claims());
      const hmac = createHmac("sha256", rsaPublicPem).update(`${head}.${body}`).digest("base64url");
      expect(await verifier.validateToken(`${head}.${body}.${hmac}`)).toMatchObject({ valid: false });
    });

    it("verifies RSA and ECDSA tokens against the public key", async () => {
      const rsaOther = generateKeyPairSync("rsa", { modulusLength: 2048 });
      const rsaVerifier = createJWTAuthProvider({ secret: rsaPublicPem, algorithm: "RS256" });
      expect(await rsaVerifier.validateToken(rs(claims(), "RS256", rsaOther.privateKey))).toMatchObject({ valid: false, error: "Invalid signature" });
      expect(await createJWTAuthProvider({ secret: rsaPublicPem, algorithm: "RS512" }).validateToken(rs(claims(), "RS512"))).toMatchObject({ valid: true });

      const ecVerifier = createJWTAuthProvider({ secret: ecPublicPem, algorithm: "ES256" });
      expect(await ecVerifier.validateToken(es(claims()))).toMatchObject({ valid: true, userId: "alice" });
      const ecOther = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
      expect(await ecVerifier.validateToken(es(claims(), ecOther.privateKey))).toMatchObject({ valid: false });
    });

    it("refuses what is not a three part token", async () => {
      for (const token of ["", "abc", "a.b", "a.b.c.d", "..", `${b64({ alg: "HS256" })}..sig`, "not.json.at-all"]) {
        expect(await provider().validateToken(token), token).toMatchObject({ valid: false });
      }
      expect(await provider().validateToken(undefined as unknown as string)).toMatchObject({ valid: false });
    });
  });

  describe("claims", () => {
    it("checks expiry (and not-before), with an optional tolerance", async () => {
      expect(await provider().validateToken(hs(secret, claims({ exp: now() - 10 })))).toMatchObject({ valid: false, error: "Token expired" });
      expect(await provider({ clockToleranceSec: 60 }).validateToken(hs(secret, claims({ exp: now() - 10 })))).toMatchObject({ valid: true });
      expect(await provider().validateToken(hs(secret, claims({ nbf: now() + 600 })))).toMatchObject({ valid: false, error: "Token not yet valid" });
      expect(await provider().validateToken(hs(secret, claims({ exp: "tomorrow" })))).toMatchObject({ valid: false });
    });

    it("lets a token without exp through unless requireExp is set", async () => {
      const token = hs(secret, { sub: "alice" });
      expect(await provider().validateToken(token)).toMatchObject({ valid: true });
      expect(await provider({ requireExp: true }).validateToken(token)).toMatchObject({ valid: false });
    });

    it("checks the issuer", async () => {
      const verifier = provider({ issuer: "my-app" });
      expect(await verifier.validateToken(hs(secret, claims({ iss: "my-app" })))).toMatchObject({ valid: true });
      expect(await verifier.validateToken(hs(secret, claims({ iss: "other" })))).toMatchObject({ valid: false, error: "Invalid issuer" });
      expect(await verifier.validateToken(hs(secret, claims()))).toMatchObject({ valid: false });
    });

    it("takes aud as a string or a list, on either side", async () => {
      const verifier = provider({ audience: "my-api" });
      expect(await verifier.validateToken(hs(secret, claims({ aud: "my-api" })))).toMatchObject({ valid: true });
      expect(await verifier.validateToken(hs(secret, claims({ aud: ["other", "my-api"] })))).toMatchObject({ valid: true });
      expect(await verifier.validateToken(hs(secret, claims({ aud: ["other"] })))).toMatchObject({ valid: false, error: "Invalid audience" });
      expect(await verifier.validateToken(hs(secret, claims()))).toMatchObject({ valid: false });
      expect(await verifier.validateToken(hs(secret, claims({ aud: 7 })))).toMatchObject({ valid: false });

      const several = provider({ audience: ["a", "b"] });
      expect(await several.validateToken(hs(secret, claims({ aud: "b" })))).toMatchObject({ valid: true });
      expect(await several.validateToken(hs(secret, claims({ aud: "c" })))).toMatchObject({ valid: false });
    });

    it("needs a user id that is a non-empty string", async () => {
      expect(await provider().validateToken(hs(secret, { exp: now() + 60 }))).toMatchObject({ valid: false, error: "No user ID in token" });
      expect(await provider().validateToken(hs(secret, claims({ sub: 42 })))).toMatchObject({ valid: false });
      expect(await provider().validateToken(hs(secret, claims({ sub: "" })))).toMatchObject({ valid: false });
      expect(await provider().validateToken(hs(secret, claims({ sub: { id: "x" } })))).toMatchObject({ valid: false });
      expect(await provider().validateToken(hs(secret, { exp: now() + 60, userId: "u1" }))).toMatchObject({ valid: true, userId: "u1" });
      expect(await provider().validateToken(hs(secret, { exp: now() + 60, user_id: "u2" }))).toMatchObject({ valid: true, userId: "u2" });
      const custom = provider({ extractUserId: (payload: Record<string, unknown>) => payload.email as string | undefined });
      expect(await custom.validateToken(hs(secret, claims({ email: "a@b.c" })))).toMatchObject({ valid: true, userId: "a@b.c" });
      expect(await custom.validateToken(hs(secret, claims()))).toMatchObject({ valid: false });
    });
  });

  describe("configuration", () => {
    it("needs a key", () => {
      expect(() => createJWTAuthProvider({ secret: "" })).toThrow(/secret/);
      expect(() => createJWTAuthProvider(undefined as never)).toThrow(/secret/);
      expect(() => createJWTAuthProvider({ secret: undefined as never })).toThrow(/secret/);
    });

    it("needs a public key of the right kind for RS* and ES*", () => {
      expect(() => createJWTAuthProvider({ secret: "not a pem", algorithm: "RS256" })).toThrow(/PEM/);
      expect(() => createJWTAuthProvider({ secret: ecPublicPem, algorithm: "RS256" })).toThrow(/RSA/);
      expect(() => createJWTAuthProvider({ secret: rsaPublicPem, algorithm: "ES256" })).toThrow(/EC/);
      expect(() => createJWTAuthProvider({ secret: ecPublicPem, algorithm: "ES384" })).toThrow(/secp384r1/);
      expect(() => createJWTAuthProvider({ secret, algorithm: "PS256" as never })).toThrow(/unsupported algorithm/i);
    });
  });
});

describe("TokenAuthProvider", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("generates tokens that are not derived from the user or the time", async () => {
    const auth = createTokenAuthProvider();
    const tokens = await Promise.all(Array.from({ length: 50 }, () => auth.generateToken("alice")));
    expect(new Set(tokens).size).toBe(50); // (many in the same millisecond)
    for (const token of tokens) {
      expect(token).toMatch(/^tok_[A-Za-z0-9_-]{43}$/);
      expect(Buffer.from(token.slice(4), "base64").toString()).not.toContain("alice");
    }
    expect(await auth.validateToken(tokens[0]!)).toEqual({ valid: true, userId: "alice" });
    // the old shape ("tok_" + base64(userId:millis)) is not a token
    const guess = `tok_${Buffer.from(`alice:${Date.now()}`).toString("base64")}`;
    expect(await auth.validateToken(guess)).toMatchObject({ valid: false });
  });

  it("keeps only a hash of a generated token", async () => {
    const statics = new Map([["static-token", "bob"]]);
    const auth = createTokenAuthProvider({ tokens: statics });
    const token = await auth.generateToken("alice");
    expect([...statics.keys()]).toEqual(["static-token"]);
    const kept = [...(auth as unknown as { issued: Map<string, unknown> }).issued.keys()];
    expect(kept).toHaveLength(1);
    expect(kept[0]).not.toBe(token);
    expect(kept[0]).not.toContain(token.slice(4));
    expect(await auth.validateToken("static-token")).toEqual({ valid: true, userId: "bob" });
  });

  it("revokes a generated token", async () => {
    const auth = createTokenAuthProvider();
    const token = await auth.generateToken("alice");
    expect(await auth.validateToken(token)).toMatchObject({ valid: true });
    await auth.revokeToken(token);
    expect(await auth.validateToken(token)).toMatchObject({ valid: false });
  });

  it("lets a generated token lapse when tokenTtlMs is set", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.UTC(2026, 0, 1));
    const auth = createTokenAuthProvider({ tokenTtlMs: 60_000 });
    const token = await auth.generateToken("alice");
    vi.setSystemTime(Date.UTC(2026, 0, 1) + 59_000);
    expect(await auth.validateToken(token)).toMatchObject({ valid: true });
    vi.setSystemTime(Date.UTC(2026, 0, 1) + 61_000);
    expect(await auth.validateToken(token)).toMatchObject({ valid: false, error: "Token expired" });
    // without a ttl they last until revoked
    const forever = createTokenAuthProvider();
    const other = await forever.generateToken("bob");
    vi.setSystemTime(Date.UTC(2030, 0, 1));
    expect(await forever.validateToken(other)).toMatchObject({ valid: true });
  });

  it("still uses a custom generateFn", async () => {
    const auth = createTokenAuthProvider({ generateFn: (userId) => `custom-${userId}` });
    expect(await auth.generateToken("alice")).toBe("custom-alice");
  });
});

describe("auth.enabled without a provider", () => {
  it("is refused when the server is created, instead of running without authentication", () => {
    expect(() =>
      createAgentServer({ basePath: "/api", storage: createInMemoryProvider(), auth: { enabled: true } })
    ).toThrow(/auth\.provider/);
    expect(() =>
      createAgentServer({ basePath: "/api", storage: createInMemoryProvider(), auth: { enabled: true, resolveUserId: () => "u" } })
    ).toThrow(/auth\.provider/);
  });

  it("is fine when authentication is off, with or without a user resolver, and with a provider", () => {
    const storage = createInMemoryProvider();
    expect(() => createAgentServer({ basePath: "/api", storage, auth: { enabled: false } })).not.toThrow();
    expect(() => createAgentServer({ basePath: "/api", storage, auth: { enabled: false, resolveUserId: () => "u" } })).not.toThrow();
    expect(() =>
      createAgentServer({ basePath: "/api", storage, auth: { enabled: true, provider: createTokenAuthProvider({ tokens: { t: "u" } }) } })
    ).not.toThrow();
  });
});
