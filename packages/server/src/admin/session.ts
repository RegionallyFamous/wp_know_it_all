import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import type { Request, Response, NextFunction } from "express";

const SESSION_COOKIE = "wp_admin_sid";
const TTL_MS = 8 * 60 * 60 * 1000; // 8 hours
const IDLE_TTL_MS = Number.parseInt(process.env["ADMIN_SESSION_IDLE_TTL_MS"] ?? "", 10) || 60 * 60 * 1000; // 1 hour
const COOKIE_REFRESH_MS =
  Number.parseInt(process.env["ADMIN_SESSION_COOKIE_REFRESH_MS"] ?? "", 10) || 15 * 60 * 1000; // 15 min

interface Session {
  userId: string;
  expiresAt: number;
  lastSeenAt: number;
  lastCookieRefreshAt: number;
}

// In-memory session store — fine for personal use
const sessions = new Map<string, Session>();

function sessionKey(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

// Sweep expired sessions every hour
setInterval(() => {
  const now = Date.now();
  for (const [token, s] of sessions) {
    if (now > s.expiresAt) sessions.delete(token);
  }
}, 3_600_000).unref();

export function createSession(userId: string): string {
  const token = randomBytes(32).toString("hex");
  const now = Date.now();
  sessions.set(sessionKey(token), {
    userId,
    expiresAt: now + TTL_MS,
    lastSeenAt: now,
    lastCookieRefreshAt: now,
  });
  return token;
}

export function destroySession(token: string): void {
  sessions.delete(sessionKey(token));
}

export function setSessionCookie(res: Response, token: string): void {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env["NODE_ENV"] === "production",
    maxAge: TTL_MS,
    path: "/admin",
  });
}

export function clearSessionCookie(res: Response): void {
  res.clearCookie(SESSION_COOKIE, { path: "/admin" });
}

export function requireAdminAuth(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const token = req.cookies?.[SESSION_COOKIE] as string | undefined;
  if (!token) {
    res.redirect("/admin/login");
    return;
  }
  const key = sessionKey(token);
  const session = sessions.get(key);
  const now = Date.now();
  const expired = !session || now > session.expiresAt;
  const idleExpired = session ? now - session.lastSeenAt > IDLE_TTL_MS : false;
  if (expired || idleExpired) {
    sessions.delete(key);
    clearSessionCookie(res);
    res.redirect("/admin/login");
    return;
  }
  session.lastSeenAt = now;
  if (now - session.lastCookieRefreshAt >= COOKIE_REFRESH_MS) {
    session.lastCookieRefreshAt = now;
    setSessionCookie(res, token);
  }
  next();
}

export function verifyAdminPassword(password: string): boolean {
  const envPassword = process.env["ADMIN_PASSWORD"];
  if (!envPassword) return false;

  const expected = createHash("sha256").update(envPassword).digest();
  const actual = createHash("sha256").update(password).digest();

  try {
    return timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

export function isAdminPasswordConfigured(): boolean {
  return Boolean(process.env["ADMIN_PASSWORD"]?.trim());
}

export function requireSameOriginPost(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  // Allow login to proceed even when proxy/browser origin headers are non-standard.
  // Keep CSRF protection enabled for all other mutating admin routes.
  if (req.path === "/login" && req.method === "POST") {
    next();
    return;
  }

  if (req.method !== "POST" && req.method !== "PUT" && req.method !== "PATCH" && req.method !== "DELETE") {
    next();
    return;
  }

  const firstHeaderValue = (value: string | undefined): string | undefined => {
    if (!value) return undefined;
    const first = value.split(",")[0]?.trim().replace(/^"+|"+$/g, "");
    return first && first.length > 0 ? first : undefined;
  };
  const canonicalHost = (value: string): string | undefined => {
    const cleaned = value.trim().replace(/^"+|"+$/g, "");
    if (!cleaned) return undefined;

    const format = (hostname: string, port: string): string => {
      const normalizedHost = hostname.toLowerCase();
      if (!port || port === "80" || port === "443") {
        return normalizedHost;
      }
      return `${normalizedHost}:${port}`;
    };

    try {
      const withScheme = cleaned.includes("://") ? cleaned : `https://${cleaned}`;
      const parsed = new URL(withScheme);
      return format(parsed.hostname, parsed.port);
    } catch {
      const hostLike = cleaned
        .replace(/^https?:\/\//i, "")
        .split("/")[0]
        ?.trim()
        .toLowerCase();
      if (!hostLike) return undefined;
      return hostLike.replace(/:(80|443)$/u, "");
    }
  };

  const originValue = firstHeaderValue(req.get("origin"));
  if (!originValue) {
    res.status(403).send("Missing Origin header.");
    return;
  }

  const hostValue = firstHeaderValue(req.get("x-forwarded-host") ?? req.get("host"));
  if (!hostValue) {
    res.status(403).send("Missing Host header.");
    return;
  }

  if (originValue.toLowerCase() === "null") {
    res.status(403).send("Invalid Origin header.");
    return;
  }
  const host = canonicalHost(hostValue);
  if (!host) {
    res.status(403).send("Missing Host header.");
    return;
  }

  const originHost = canonicalHost(originValue);
  if (!originHost) {
    res.status(403).send("Invalid Origin header.");
    return;
  }

  if (originHost !== host) {
    res.status(403).send("Cross-origin request blocked.");
    return;
  }

  next();
}
