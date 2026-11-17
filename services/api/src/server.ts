import { PrismaClient } from "@prisma/client";
import { buildServer } from "./app.js";
import { config } from "./config.js";

const prisma = new PrismaClient();
const app = await buildServer({ prisma, authSigningSecret: process.env.AUTH_SIGNING_SECRET });

try {
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  app.log.error(error);
  process.exitCode = 1;
}
