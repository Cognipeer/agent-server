/**
 * Base Auth Provider - simple token-based authentication
 */

import { createHash, createHmac, createPublicKey, randomBytes, timingSafeEqual, verify } from "node:crypto";
import type { KeyObject } from "node:crypto";
import type { AuthProvider, AuthResult } from "../../types.js";

export interface TokenAuthConfig {
  /**
   * Static tokens map: token -> userId
   */
  tokens?: Map<string, string> | Record<string, string>;

  /**
   * Custom token validation function
   */
  validateFn?: (token: string) => Promise<AuthResult> | AuthResult;

  /**
   * Token generation function
   */
  generateFn?: (userId: string, metadata?: Record<string, unknown>) => Promise<string> | string;

  /**
   * How long a token made by `generateToken` is good for, in milliseconds. Without it such a token lives until it is revoked
   * (or the process ends: they are kept in memory). Static `tokens` are not affected.
   */
  tokenTtlMs?: number;
}

/**
 * Simple token-based auth provider
 */
export class TokenAuthProvider implements AuthProvider {
  private tokens: Map<string, string>;
  /** Tokens made by `generateToken`, by the hash of the token: the token itself is only ever held by the caller. */
  private issued = new Map<string, { userId: string; expiresAt?: number }>();
  private validateFn?: TokenAuthConfig["validateFn"];
  private generateFn?: TokenAuthConfig["generateFn"];
  private tokenTtlMs?: number;

  constructor(config: TokenAuthConfig = {}) {
    this.tokens =
      config.tokens instanceof Map
        ? config.tokens
        : new Map(Object.entries(config.tokens || {}));
    this.validateFn = config.validateFn;
    this.generateFn = config.generateFn;
    this.tokenTtlMs =
      typeof config.tokenTtlMs === "number" && Number.isFinite(config.tokenTtlMs) && config.tokenTtlMs > 0 ? config.tokenTtlMs : undefined;
  }

  async validateToken(token: string): Promise<AuthResult> {
    // Custom validation takes priority
    if (this.validateFn) {
      return this.validateFn(token);
    }

    // Static token lookup
    const userId = this.tokens.get(token);
    if (userId) {
      return { valid: true, userId };
    }

    // A token made by generateToken
    const key = hashToken(token);
    const issued = this.issued.get(key);
    if (issued) {
      if (issued.expiresAt !== undefined && Date.now() >= issued.expiresAt) {
        this.issued.delete(key);
        return { valid: false, error: "Token expired" };
      }
      return { valid: true, userId: issued.userId };
    }

    return { valid: false, error: "Invalid token" };
  }

  async generateToken(
    userId: string,
    metadata?: Record<string, unknown>
  ): Promise<string> {
    if (this.generateFn) {
      return this.generateFn(userId, metadata);
    }

    // 256 random bits: not derived from the user or the time, so it cannot be guessed. Only its hash is kept.
    const token = `tok_${randomBytes(32).toString("base64url")}`;
    this.issued.set(hashToken(token), {
      userId,
      ...(this.tokenTtlMs !== undefined && { expiresAt: Date.now() + this.tokenTtlMs }),
    });
    return token;
  }

  async revokeToken(token: string): Promise<void> {
    this.tokens.delete(token);
    this.issued.delete(hashToken(token));
  }

  /**
   * Add a static token
   */
  addToken(token: string, userId: string): void {
    this.tokens.set(token, userId);
  }

  /**
   * Remove a static token
   */
  removeToken(token: string): void {
    this.tokens.delete(token);
  }
}

/** SHA-256 of a token, base64url: what is kept in place of a token made by `generateToken`. */
function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}

/**
 * JWT signing algorithms the provider verifies. The one it accepts is fixed by the configuration, never taken from the
 * token's header.
 */
export type JWTAlgorithm = "HS256" | "HS384" | "HS512" | "RS256" | "RS384" | "RS512" | "ES256" | "ES384" | "ES512";

const JWT_ALGORITHMS: Record<JWTAlgorithm, { hash: "sha256" | "sha384" | "sha512"; family: "HS" | "RS" | "ES"; curve?: string }> = {
  HS256: { hash: "sha256", family: "HS" },
  HS384: { hash: "sha384", family: "HS" },
  HS512: { hash: "sha512", family: "HS" },
  RS256: { hash: "sha256", family: "RS" },
  RS384: { hash: "sha384", family: "RS" },
  RS512: { hash: "sha512", family: "RS" },
  ES256: { hash: "sha256", family: "ES", curve: "prime256v1" },
  ES384: { hash: "sha384", family: "ES", curve: "secp384r1" },
  ES512: { hash: "sha512", family: "ES", curve: "secp521r1" },
};

/**
 * JWT Auth Provider configuration
 */
export interface JWTAuthConfig {
  /**
   * HS*: the shared secret. RS* / ES*: the PEM public key (or certificate) the tokens are verified with.
   * Required: a provider without a key would accept anything.
   */
  secret: string;

  /**
   * The one algorithm tokens must be signed with (default: "HS256"). A token whose header names another is refused.
   */
  algorithm?: JWTAlgorithm;

  /**
   * Issuer to validate
   */
  issuer?: string;

  /**
   * Audience to validate: the token's `aud` (a string or a list) has to contain it, or one of them when this is a list
   */
  audience?: string | string[];

  /**
   * Seconds of clock difference tolerated for `exp` and `nbf` (default 0)
   */
  clockToleranceSec?: number;

  /**
   * Refuse a token that has no `exp` (default false: such a token does not expire)
   */
  requireExp?: boolean;

  /**
   * Custom claims extractor
   */
  extractUserId?: (payload: Record<string, unknown>) => string | undefined;
}

/**
 * JWT-based auth provider. It verifies the signature (HMAC with a shared secret, RSA or ECDSA with a public key), then
 * `exp`, `nbf`, `iss` and `aud`, and takes the user from `sub` (or `userId` / `user_id`, or `extractUserId`).
 *
 * The key type comes from the configuration, never from the token: `alg: "none"`, an algorithm other than the configured one
 * and an RSA key used as an HMAC secret are all refused. There is no JWKS support: for keys that rotate, write an
 * `AuthProvider` on a JWT library (`jose`) or verify in front of the server.
 */
export class JWTAuthProvider implements AuthProvider {
  private config: JWTAuthConfig;
  private algorithm: JWTAlgorithm;
  private key: Buffer | KeyObject;

  constructor(config: JWTAuthConfig) {
    if (!config || typeof config.secret !== "string" || config.secret.length === 0) {
      throw new Error("JWTAuthProvider needs a `secret`: the shared secret (HS*) or the PEM public key (RS*, ES*) that tokens are verified with");
    }
    const algorithm = config.algorithm ?? "HS256";
    const spec = JWT_ALGORITHMS[algorithm];
    if (!spec) {
      throw new Error(`JWTAuthProvider: unsupported algorithm "${String(algorithm)}" (supported: ${Object.keys(JWT_ALGORITHMS).join(", ")})`);
    }
    this.config = config;
    this.algorithm = algorithm;
    if (spec.family === "HS") {
      this.key = Buffer.from(config.secret, "utf8");
    } else {
      let key: KeyObject;
      try {
        key = createPublicKey(config.secret);
      } catch {
        throw new Error(`JWTAuthProvider: \`secret\` has to be a PEM public key (or certificate) for ${algorithm}`);
      }
      if (key.asymmetricKeyType !== (spec.family === "RS" ? "rsa" : "ec")) {
        throw new Error(`JWTAuthProvider: the key is not ${spec.family === "RS" ? "an RSA" : "an EC"} key, which ${algorithm} needs`);
      }
      if (spec.curve && key.asymmetricKeyDetails?.namedCurve !== spec.curve) {
        throw new Error(`JWTAuthProvider: ${algorithm} needs a ${spec.curve} key`);
      }
      this.key = key;
    }
  }

  async validateToken(token: string): Promise<AuthResult> {
    try {
      const parts = typeof token === "string" ? token.split(".") : [];
      if (parts.length !== 3 || parts.some((part) => part.length === 0)) {
        return { valid: false, error: "Invalid JWT format" };
      }
      const [encodedHeader, encodedPayload, encodedSignature] = parts as [string, string, string];

      const header = parseJsonObject(encodedHeader);
      // The algorithm is the configured one; whatever the header says must match it (no "none", no switching of key type)
      if (!header || header.alg !== this.algorithm || header.crit !== undefined) {
        return { valid: false, error: "Unsupported algorithm" };
      }
      if (!this.signatureMatches(`${encodedHeader}.${encodedPayload}`, encodedSignature)) {
        return { valid: false, error: "Invalid signature" };
      }

      const payload = parseJsonObject(encodedPayload);
      if (!payload) return { valid: false, error: "Invalid token" };

      const now = Date.now() / 1000;
      const tolerance = this.config.clockToleranceSec ?? 0;
      if (payload.exp !== undefined) {
        if (typeof payload.exp !== "number" || !Number.isFinite(payload.exp)) return { valid: false, error: "Invalid token" };
        if (now >= payload.exp + tolerance) return { valid: false, error: "Token expired" };
      } else if (this.config.requireExp) {
        return { valid: false, error: "Token has no expiry" };
      }
      if (payload.nbf !== undefined) {
        if (typeof payload.nbf !== "number" || !Number.isFinite(payload.nbf)) return { valid: false, error: "Invalid token" };
        if (now < payload.nbf - tolerance) return { valid: false, error: "Token not yet valid" };
      }

      if (this.config.issuer && payload.iss !== this.config.issuer) {
        return { valid: false, error: "Invalid issuer" };
      }

      if (this.config.audience !== undefined) {
        const wanted = Array.isArray(this.config.audience) ? this.config.audience : [this.config.audience];
        const given = (Array.isArray(payload.aud) ? payload.aud : [payload.aud]).filter((aud): aud is string => typeof aud === "string");
        if (!wanted.some((aud) => given.includes(aud))) {
          return { valid: false, error: "Invalid audience" };
        }
      }

      // The user: a non-empty string
      const userId = this.config.extractUserId
        ? this.config.extractUserId(payload)
        : [payload.sub, payload.userId, payload.user_id].find((value) => typeof value === "string" && value.length > 0);
      if (typeof userId !== "string" || userId.length === 0) {
        return { valid: false, error: "No user ID in token" };
      }

      return {
        valid: true,
        userId,
        metadata: payload,
      };
    } catch {
      return { valid: false, error: "Invalid token" };
    }
  }

  /** Whether `encodedSignature` is the signature of `signed` under the configured key. */
  private signatureMatches(signed: string, encodedSignature: string): boolean {
    const spec = JWT_ALGORITHMS[this.algorithm];
    const data = Buffer.from(signed, "utf8");
    const signature = Buffer.from(encodedSignature, "base64url");
    if (spec.family === "HS") {
      const expected = createHmac(spec.hash, this.key as Buffer).update(data).digest();
      return signature.length === expected.length && timingSafeEqual(signature, expected);
    }
    // (RSA: PKCS#1 v1.5; ECDSA: the fixed-width r||s form JWTs use)
    return verify(
      spec.hash,
      data,
      spec.family === "ES" ? { key: this.key as KeyObject, dsaEncoding: "ieee-p1363" } : (this.key as KeyObject),
      signature
    );
  }
}

/** A base64url JSON segment that holds an object, else null. */
function parseJsonObject(segment: string): Record<string, unknown> | null {
  const value: unknown = JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

// Export factory functions
export function createTokenAuthProvider(config: TokenAuthConfig = {}): TokenAuthProvider {
  return new TokenAuthProvider(config);
}

export function createJWTAuthProvider(config: JWTAuthConfig): JWTAuthProvider {
  return new JWTAuthProvider(config);
}
