import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import type { Request, Response, NextFunction } from "express";

const SESSION_COOKIE = "wp_admin_sid";
const TTL_MS = 8 * 60 * 60 * 1000; // 8 hours

interface Session {
  userId: string;
  expiresAt: number;
}

// In-memory session store — fine for personal use
const sessions = new Map<string, Session>();

// Sweep expired sessions every hour
setInterval(() => {
  const now = Date.now();
  for (const [token, s] of sessions) {
    if (now > s.expiresAt) sessions.delete(token);
  }
}, 3_600_000).unref();

export function createSession(userId: string): string {
  const token = randomBytes(32).toString("hex");
  sessions.set(token, { userId, expiresAt: Date.now() + TTL_MS });
  return token;
}

export function destroySession(token: string): void {
  sessions.delete(token);
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
  const session = sessions.get(token);
  if (!session || Date.now() > session.expiresAt) {
    sessions.delete(token ?? "");
    clearSessionCookie(res);
    res.redirect("/admin/login");
    return;
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
  if (req.method !== "POST" && req.method !== "PUT" && req.method !== "PATCH" && req.method !== "DELETE") {
    next();
    return;
  }

  const firstHeaderValue = (value: string | undefined): string | undefined => {
    if (!value) return undefined;
    const first = value.split(",")[0]?.trim().replace(/^"+|"+$/g, "");
    return first && first.length > 0 ? first : undefined;
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
  const host = hostValue.toLowerCase();

  let originHost: string;
  try {
    originHost = new URL(originValue).host.toLowerCase();
  } catch {
    // Some proxies/clients may send a host-like value instead of full URL.
    const fallbackOriginHost = originValue
      .replace(/^https?:\/\//i, "")
      .split("/")[0]
      ?.trim()
      .toLowerCase();
    if (!fallbackOriginHost) {
      res.status(403).send("Invalid Origin header.");
      return;
    }
    originHost = fallbackOriginHost;
  }

  if (originHost !== host) {
    res.status(403).send("Cross-origin request blocked.");
    return;
  }

  next();
}
