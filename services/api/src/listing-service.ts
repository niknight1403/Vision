import { randomUUID } from "node:crypto";
import { desc, eq, sql } from "drizzle-orm";
import type { ProviderProduct } from "./providers/types.js";
import type { ListingDatabase } from "./db/index.js";
import { providerListings } from "./db/schema.js";

export type ProviderListingRecord = typeof providerListings.$inferSelect;

export interface ProviderListingStore {
  listForUser(userId: string, limit: number): Promise<ProviderListingRecord[]>;
  upsertForUser(userId: string, products: readonly ProviderProduct[]): Promise<ProviderListingRecord[]>;
}

export function createProviderListingStore(db: ListingDatabase): ProviderListingStore {
  return {
    async listForUser(userId, limit) {
      if (!userId.trim()) throw new Error("LISTING_USER_REQUIRED");
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        throw new Error("LISTING_LIMIT_INVALID");
      }
      return await db.select().from(providerListings)
        .where(eq(providerListings.userId, userId))
        .orderBy(desc(providerListings.updatedAt))
        .limit(limit);
    },

    async upsertForUser(userId, products) {
      if (!userId.trim()) throw new Error("LISTING_USER_REQUIRED");
      if (products.length > 50) throw new Error("LISTING_BATCH_LIMIT_EXCEEDED");
      if (products.length === 0) return [];
      const now = new Date();
      const values = products.map((product) => ({
        id: randomUUID(),
        userId,
        providerId: product.providerId,
        externalId: product.externalId,
        title: product.title,
        productUrl: product.url,
        imageUrl: product.imageUrl ?? null,
        currency: product.currency,
        priceMinor: BigInt(product.priceMinor),
        observedAt: new Date(product.observedAt),
        createdAt: now,
        updatedAt: now,
      }));
      return await db.insert(providerListings).values(values).onConflictDoUpdate({
        target: [providerListings.userId, providerListings.providerId, providerListings.externalId],
        set: {
          title: sql`excluded."title"`,
          productUrl: sql`excluded."productUrl"`,
          imageUrl: sql`excluded."imageUrl"`,
          currency: sql`excluded."currency"`,
          priceMinor: sql`excluded."priceMinor"`,
          observedAt: sql`excluded."observedAt"`,
          updatedAt: sql`excluded."updatedAt"`,
        },
      }).returning();
    },
  };
}
