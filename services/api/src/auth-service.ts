import { createHmac, timingSafeEqual } from "node:crypto";
import type { PrismaClient, UserRole } from "@prisma/client";

const ISSUER = "autonomagent-auth";
const AUDIENCE = "autonomagent-api";
const MAX_TOKEN_LENGTH = 8_192;

type JwtHeader = { alg?: unknown; typ?: unknown };
type JwtClaims = {
  sub?: unknown;
  iss?: unknown;
  aud?: unknown;
  exp?: unknown;
  iat?: unknown;
  nbf?: unknown;
};

export interface AuthenticatedPrincipal {
  userId: string;
  email: string;
  role: UserRole;
}

/** Verify a short-lived HS256 access token and reload authorization from the DB. */
export async function authenticateBearerToken(
  prisma: Pick<PrismaClient, "user">,
  authorization: string | undefined,
  secret: string | undefined,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<AuthenticatedPrincipal> {
  if (!secret || Buffer.byteLength(secret, "utf8") < 32) {
    throw new Error("AUTH_SIGNING_SECRET_NOT_CONFIGURED");
  }
  if (!authorization?.startsWith("Bearer ")) throw new Error("AUTHENTICATION_REQUIRED");
  const token = authorization.slice(7);
  if (!token || token.length > MAX_TOKEN_LENGTH) throw new Error("AUTH_TOKEN_INVALID");

  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((part) => !part)) throw new Error("AUTH_TOKEN_INVALID");

  let header: JwtHeader;
  let claims: JwtClaims;
  try {
    header = JSON.parse(Buffer.from(parts[0]!, "base64url").toString("utf8")) as JwtHeader;
    claims = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as JwtClaims;
  } catch {
    throw new Error("AUTH_TOKEN_INVALID");
  }

  if (header.alg !== "HS256" || header.typ !== "JWT" || Object.keys(header).some((key) => key !== "alg" && key !== "typ")) throw new Error("AUTH_TOKEN_INVALID");
  const expected = createHmac("sha256", secret).update(`${parts[0]}.${parts[1]}`).digest();
  let supplied: Buffer;
  try {
    supplied = Buffer.from(parts[2]!, "base64url");
  } catch {
    throw new Error("AUTH_TOKEN_INVALID");
  }
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    throw new Error("AUTH_TOKEN_INVALID");
  }

  if (
    claims.iss !== ISSUER ||
    claims.aud !== AUDIENCE ||
    typeof claims.sub !== "string" ||
    !claims.sub ||
    !Number.isInteger(claims.exp) ||
    !Number.isInteger(claims.iat) ||
    (claims.nbf !== undefined && !Number.isInteger(claims.nbf))
  ) throw new Error("AUTH_TOKEN_INVALID");

  const issuedAt = claims.iat as number;
  const expiresAt = claims.exp as number;
  if (issuedAt > nowSeconds + 30 || expiresAt <= nowSeconds || expiresAt <= issuedAt ||
      expiresAt - issuedAt > 15 * 60 ||
      (typeof claims.nbf === "number" && claims.nbf > nowSeconds)) {
    throw new Error("AUTH_TOKEN_EXPIRED_OR_NOT_ACTIVE");
  }

  const user = await prisma.user.findUnique({
    where: { id: claims.sub },
    select: { id: true, email: true, role: true, disabledAt: true },
  });
  if (!user || user.disabledAt) throw new Error("AUTHENTICATED_USER_UNAVAILABLE");
  return { userId: user.id, email: user.email, role: user.role };
}

export function requireAdmin(principal: AuthenticatedPrincipal): void {
  if (principal.role !== "ADMIN") throw new Error("ADMIN_ROLE_REQUIRED");
}

export const authTokenContract = Object.freeze({ issuer: ISSUER, audience: AUDIENCE, maxLifetimeSeconds: 900 });
