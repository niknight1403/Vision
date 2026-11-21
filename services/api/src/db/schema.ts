import { bigint, index, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

export const providerListings = pgTable("ProviderListing", {
  id: text("id").primaryKey(),
  userId: text("userId").notNull(),
  providerId: text("providerId").notNull(),
  externalId: text("externalId").notNull(),
  title: text("title").notNull(),
  productUrl: text("productUrl").notNull(),
  imageUrl: text("imageUrl"),
  currency: text("currency").notNull().default("EUR"),
  priceMinor: bigint("priceMinor", { mode: "bigint" }).notNull(),
  observedAt: timestamp("observedAt", { mode: "date" }).notNull(),
  createdAt: timestamp("createdAt", { mode: "date" }).notNull().defaultNow(),
  updatedAt: timestamp("updatedAt", { mode: "date" }).notNull(),
}, (table) => [
  uniqueIndex("ProviderListing_userId_providerId_externalId_key")
    .on(table.userId, table.providerId, table.externalId),
  index("ProviderListing_userId_observedAt_idx").on(table.userId, table.observedAt),
  index("ProviderListing_userId_createdAt_idx").on(table.userId, table.createdAt),
]);

export const databaseSchema = { providerListings };
