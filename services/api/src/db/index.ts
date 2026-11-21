import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { databaseSchema } from "./schema.js";

export type ListingDatabase = NodePgDatabase<typeof databaseSchema>;

export function createListingDatabase(connectionString = process.env.DATABASE_URL) {
  if (!connectionString) throw new Error("DATABASE_URL_NOT_CONFIGURED");
  const pool = new Pool({ connectionString, max: 5, idleTimeoutMillis: 30_000 });
  const db = drizzle(pool, { schema: databaseSchema });
  return {
    db,
    close: () => pool.end(),
  };
}
