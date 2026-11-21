import { PrismaClient } from "@prisma/client";
import { buildServer } from "./app.js";
import { config } from "./config.js";
import { createHttpVisionInspector, type VisionInspector } from "./vision-inspector.js";
import { createListingDatabase } from "./db/index.js";
import { createProviderListingStore } from "./listing-service.js";
import { createConfiguredProviderRegistry } from "./providers/bootstrap.js";

/**
 * The inspection route stays at 503 VISION_INSPECTOR_NOT_CONFIGURED until both
 * the worker URL and the shared secret are present. A malformed configuration
 * disables the route instead of preventing the API from starting.
 */
function visionInspectorFromEnv(): VisionInspector | undefined {
  const url = process.env.VISION_WORKER_URL;
  const token = process.env.VISION_WORKER_TOKEN;
  if (!url || !token) return undefined;
  try {
    return createHttpVisionInspector({ url, token });
  } catch (error) {
    console.error(
      "vision inspection disabled:",
      error instanceof Error ? error.message : "unknown configuration error",
    );
    return undefined;
  }
}

const prisma = new PrismaClient();
const listingDatabase = process.env.DATABASE_URL
  ? createListingDatabase(process.env.DATABASE_URL)
  : undefined;
const app = await buildServer({
  prisma,
  authSigningSecret: process.env.AUTH_SIGNING_SECRET,
  visionInspector: visionInspectorFromEnv(),
  listingStore: listingDatabase ? createProviderListingStore(listingDatabase.db) : undefined,
  providers: createConfiguredProviderRegistry(),
});
app.addHook("onClose", async () => {
  await listingDatabase?.close();
  await prisma.$disconnect();
});

try {
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  app.log.error(error);
  process.exitCode = 1;
}
