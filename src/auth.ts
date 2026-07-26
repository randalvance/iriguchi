import type { Context, MiddlewareHandler } from "hono";
import { randomBytes, timingSafeEqual } from "node:crypto";

export function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return timingSafeEqual(bufA, bufB);
}

function unauthorized(c: Context, message = "Missing or invalid bearer token") {
  return c.json(
    {
      error: {
        type: "invalid_request_error",
        message,
        code: "unauthorized",
      },
    },
    401,
  );
}

export type BearerAuthOpts = {
  tokens?: string[];
  resolve?: (c: Context) => Promise<string[]> | string[];
};

export function bearerAuth(opts: BearerAuthOpts): MiddlewareHandler {
  if (opts.tokens === undefined && opts.resolve === undefined) {
    throw new Error("bearerAuth: must supply either `tokens` or `resolve`");
  }
  return async (c, next) => {
    const header = c.req.header("Authorization");
    if (!header?.startsWith("Bearer ")) return unauthorized(c);
    const presented = header.slice(7).trim();
    const valid = opts.tokens ?? (await opts.resolve!(c));
    for (const candidate of valid) {
      if (constantTimeEqual(presented, candidate)) {
        return next();
      }
    }
    return unauthorized(c);
  };
}
