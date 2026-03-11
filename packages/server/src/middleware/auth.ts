import type { RequestHandler } from "express";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { createHash, timingSafeEqual } from "node:crypto";

function constantTimeTokenMatch(expectedToken: string, providedToken: string): boolean {
  const expected = createHash("sha256").update(expectedToken).digest();
  const provided = createHash("sha256").update(providedToken).digest();
  try {
    return timingSafeEqual(expected, provided);
  } catch {
    return false;
  }
}

export function createAuthMiddleware(token: string): RequestHandler {
  return requireBearerAuth({
    verifier: {
      verifyAccessToken: (providedToken: string) => {
        if (!constantTimeTokenMatch(token, providedToken)) {
          throw new Error("Invalid token");
        }
        return Promise.resolve({
          token: providedToken,
          clientId: "static-client",
          scopes: [] as string[],
          expiresAt: Math.floor(Date.now() / 1000) + 86_400,
        });
      },
    },
  });
}

export function isMcpAuthConfigured(): boolean {
  return Boolean(process.env["MCP_AUTH_TOKEN"]?.trim());
}
