import {
  createHash,
  createHmac,
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from "node:crypto";
import type { ScryptOptions } from "node:crypto";
import { promisify } from "node:util";
import type { Prisma, PrismaClient } from "@prisma/client";

type ScryptAsync = (
  password: string | Buffer,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions,
) => Promise<Buffer>;

const scrypt = promisify(scryptCallback) as ScryptAsync;
const ACCESS_TTL_SECONDS = 15 * 60;
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const SCRYPT_N = 32_768;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEY_LENGTH = 32;
const SCRYPT_MAXMEM = 128 * 1024 * 1024;
const DUMMY_PASSWORD_HASH = `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`;

export interface AuthTokenPair {
  tokenType: "Bearer";
  accessToken: string;
  accessTokenExpiresIn: number;
  refreshToken: string;
  refreshTokenExpiresAt: string;
}

function validatePassword(password: string): void {
  const bytes = Buffer.byteLength(password, "utf8");
  if (bytes < 12 || bytes > 128) throw new Error("PASSWORD_POLICY_VIOLATION");
}

async function derivePassword(password: string, salt: Buffer): Promise<Buffer> {
  return await scrypt(password, salt, SCRYPT_KEY_LENGTH, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM,
  }) as Buffer;
}

export async function hashPassword(password: string): Promise<string> {
  validatePassword(password);
  const salt = randomBytes(16);
  const derived = await derivePassword(password, salt);
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString("base64url")}$${derived.toString("base64url")}`;
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const parts = encoded.split("$");
  if (
    parts.length !== 6 ||
    parts[0] !== "scrypt" ||
    parts[1] !== String(SCRYPT_N) ||
    parts[2] !== String(SCRYPT_R) ||
    parts[3] !== String(SCRYPT_P)
  ) return false;

  try {
    const salt = Buffer.from(parts[4]!, "base64url");
    const expected = Buffer.from(parts[5]!, "base64url");
    if (salt.length !== 16 || expected.length !== SCRYPT_KEY_LENGTH) return false;
    const actual = await derivePassword(password, salt);
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

function signAccessToken(userId: string, secret: string, nowSeconds: number): string {
  if (Buffer.byteLength(secret, "utf8") < 32) throw new Error("AUTH_SIGNING_SECRET_NOT_CONFIGURED");
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({ alg: "HS256", typ: "JWT" });
  const payload = encode({
    sub: userId,
    iss: "autonomagent-auth",
    aud: "autonomagent-api",
    iat: nowSeconds,
    exp: nowSeconds + ACCESS_TTL_SECONDS,
  });
  const signature = createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${signature}`;
}

function hashRefreshToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function createRefreshToken(): string {
  return randomBytes(48).toString("base64url");
}

function tokenPair(userId: string, refreshToken: string, refreshExpiresAt: Date, secret: string, now: Date): AuthTokenPair {
  return {
    tokenType: "Bearer",
    accessToken: signAccessToken(userId, secret, Math.floor(now.getTime() / 1000)),
    accessTokenExpiresIn: ACCESS_TTL_SECONDS,
    refreshToken,
    refreshTokenExpiresAt: refreshExpiresAt.toISOString(),
  };
}

/** Authenticate credentials and persist only a SHA-256 hash of the refresh token. */
export async function loginWithPassword(
  prisma: PrismaClient,
  input: { email: string; password: string },
  signingSecret: string,
  now = new Date(),
): Promise<AuthTokenPair> {
  if (Buffer.byteLength(signingSecret, "utf8") < 32) throw new Error("AUTH_SIGNING_SECRET_NOT_CONFIGURED");
  const email = input.email.trim().toLowerCase();
  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, passwordHash: true, disabledAt: true },
  });
  const valid = await verifyPassword(input.password, user?.passwordHash ?? DUMMY_PASSWORD_HASH);
  if (!user || user.disabledAt || !valid) throw new Error("INVALID_CREDENTIALS");

  const refreshToken = createRefreshToken();
  const expiresAt = new Date(now.getTime() + REFRESH_TTL_MS);
  await prisma.refreshSession.create({
    data: { userId: user.id, tokenHash: hashRefreshToken(refreshToken), expiresAt },
  });
  return tokenPair(user.id, refreshToken, expiresAt, signingSecret, now);
}

/** One-time refresh rotation. A conditional update ensures concurrent reuse loses. */
export async function rotateRefreshToken(
  prisma: PrismaClient,
  refreshToken: string,
  signingSecret: string,
  now = new Date(),
): Promise<AuthTokenPair> {
  if (Buffer.byteLength(signingSecret, "utf8") < 32) throw new Error("AUTH_SIGNING_SECRET_NOT_CONFIGURED");
  if (!refreshToken || refreshToken.length > 256) throw new Error("INVALID_REFRESH_TOKEN");
  const tokenHash = hashRefreshToken(refreshToken);
  const existing = await prisma.refreshSession.findUnique({
    where: { tokenHash },
    include: { user: { select: { id: true, disabledAt: true } } },
  });
  if (!existing || existing.revokedAt || existing.expiresAt <= now || existing.user.disabledAt) {
    throw new Error("INVALID_REFRESH_TOKEN");
  }

  const nextRefreshToken = createRefreshToken();
  const nextExpiresAt = new Date(now.getTime() + REFRESH_TTL_MS);
  await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const claimed = await tx.refreshSession.updateMany({
      where: { id: existing.id, revokedAt: null, expiresAt: { gt: now } },
      data: { revokedAt: now },
    });
    if (claimed.count !== 1) throw new Error("REFRESH_TOKEN_REUSE_OR_RACE");
    const created = await tx.refreshSession.create({
      data: { userId: existing.userId, tokenHash: hashRefreshToken(nextRefreshToken), expiresAt: nextExpiresAt },
    });
    await tx.refreshSession.update({
      where: { id: existing.id },
      data: { replacedById: created.id },
    });
  }, { isolationLevel: "Serializable" });

  return tokenPair(existing.userId, nextRefreshToken, nextExpiresAt, signingSecret, now);
}

export async function revokeRefreshToken(
  prisma: PrismaClient,
  refreshToken: string,
  now = new Date(),
): Promise<void> {
  if (!refreshToken || refreshToken.length > 256) return;
  await prisma.refreshSession.updateMany({
    where: { tokenHash: hashRefreshToken(refreshToken), revokedAt: null },
    data: { revokedAt: now },
  });
}
