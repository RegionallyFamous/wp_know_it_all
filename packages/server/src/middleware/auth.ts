import type { RequestHandler } from "express";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";

const TOKEN = process.env["MCP_AUTH_TOKEN"];

if (!TOKEN) {
  console.warn(
    "[auth] MCP_AUTH_TOKEN is not set — server is unauthenticated. Set this in Railway environment variables."
  );
}

export const authMiddleware: RequestHandler | null = TOKEN
  ? (requireBearerAuth({
      verifier: {
        verifyAccessToken: async (token: string) => {
          if (token !== TOKEN) throw new Error("Invalid token");
          return {
            token,
            clientId: "static-client",
            scopes: [] as string[],
            expiresAt: Math.floor(Date.now() / 1000) + 86_400,
          };
        },
      },
    }) as RequestHandler)
  : null;
