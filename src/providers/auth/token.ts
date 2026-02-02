/**
 * Base Auth Provider - simple token-based authentication
 */

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
}

/**
 * Simple token-based auth provider
 */
export class TokenAuthProvider implements AuthProvider {
  private tokens: Map<string, string>;
  private validateFn?: TokenAuthConfig["validateFn"];
  private generateFn?: TokenAuthConfig["generateFn"];

  constructor(config: TokenAuthConfig = {}) {
    this.tokens =
      config.tokens instanceof Map
        ? config.tokens
        : new Map(Object.entries(config.tokens || {}));
    this.validateFn = config.validateFn;
    this.generateFn = config.generateFn;
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

    return { valid: false, error: "Invalid token" };
  }

  async generateToken(
    userId: string,
    metadata?: Record<string, unknown>
  ): Promise<string> {
    if (this.generateFn) {
      return this.generateFn(userId, metadata);
    }

    // Simple token generation
    const token = `tok_${Buffer.from(`${userId}:${Date.now()}`).toString("base64")}`;
    this.tokens.set(token, userId);
    return token;
  }

  async revokeToken(token: string): Promise<void> {
    this.tokens.delete(token);
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

/**
 * JWT Auth Provider configuration
 */
export interface JWTAuthConfig {
  /**
   * Secret for HS256 or public key for RS256
   */
  secret: string;

  /**
   * Algorithm (default: "HS256")
   */
  algorithm?: "HS256" | "RS256";

  /**
   * Issuer to validate
   */
  issuer?: string;

  /**
   * Audience to validate
   */
  audience?: string;

  /**
   * Custom claims extractor
   */
  extractUserId?: (payload: Record<string, unknown>) => string | undefined;
}

/**
 * JWT-based auth provider (basic implementation)
 * For production, consider using a proper JWT library
 */
export class JWTAuthProvider implements AuthProvider {
  private config: JWTAuthConfig;

  constructor(config: JWTAuthConfig) {
    this.config = config;
  }

  async validateToken(token: string): Promise<AuthResult> {
    try {
      // Basic JWT validation (header.payload.signature)
      const parts = token.split(".");
      if (parts.length !== 3) {
        return { valid: false, error: "Invalid JWT format" };
      }

      const payload = JSON.parse(
        Buffer.from(parts[1], "base64url").toString("utf-8")
      );

      // Check expiration
      if (payload.exp && Date.now() >= payload.exp * 1000) {
        return { valid: false, error: "Token expired" };
      }

      // Check issuer
      if (this.config.issuer && payload.iss !== this.config.issuer) {
        return { valid: false, error: "Invalid issuer" };
      }

      // Check audience
      if (this.config.audience && payload.aud !== this.config.audience) {
        return { valid: false, error: "Invalid audience" };
      }

      // Extract user ID
      const userId = this.config.extractUserId
        ? this.config.extractUserId(payload)
        : payload.sub || payload.userId || payload.user_id;

      if (!userId) {
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
}

// Export factory functions
export function createTokenAuthProvider(config: TokenAuthConfig = {}): TokenAuthProvider {
  return new TokenAuthProvider(config);
}

export function createJWTAuthProvider(config: JWTAuthConfig): JWTAuthProvider {
  return new JWTAuthProvider(config);
}
