import { PrismaClient } from "@prisma/client";
import { hashPassword } from "./auth-session-service.js";

const ADMIN_EMAIL = "niko.oeben@gmail.com";

export async function bootstrapAdmin(
  prisma: PrismaClient,
  env: NodeJS.ProcessEnv = process.env,
): Promise<"created" | "already-admin"> {
  const email = env.ADMIN_BOOTSTRAP_EMAIL?.trim().toLowerCase();
  const password = env.ADMIN_BOOTSTRAP_PASSWORD;

  if (email !== ADMIN_EMAIL) {
    throw new Error("ADMIN_BOOTSTRAP_EMAIL_MUST_MATCH_APPROVED_ADMIN");
  }
  if (!password || Buffer.byteLength(password, "utf8") < 16 || Buffer.byteLength(password, "utf8") > 128) {
    throw new Error("ADMIN_BOOTSTRAP_PASSWORD_MUST_BE_16_TO_128_BYTES");
  }

  const existing = await prisma.user.findUnique({
    where: { email },
    select: { id: true, role: true, disabledAt: true },
  });
  if (existing) {
    if (existing.role === "ADMIN" && !existing.disabledAt) return "already-admin";
    throw new Error("ADMIN_BOOTSTRAP_ACCOUNT_EXISTS_REQUIRES_MANUAL_REVIEW");
  }

  const passwordHash = await hashPassword(password);
  await prisma.user.create({
    data: { email, passwordHash, role: "ADMIN" },
  });
  return "created";
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  const prisma = new PrismaClient();
  try {
    const result = await bootstrapAdmin(prisma);
    process.stdout.write(result === "created"
      ? "Initial administrator account created. Sign in with the configured credentials.\n"
      : "Initial administrator account is already active. No changes made.\n");
  } catch (error) {
    process.stderr.write(`Administrator bootstrap failed: ${error instanceof Error ? error.message : "UNKNOWN_ERROR"}\n`);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}
