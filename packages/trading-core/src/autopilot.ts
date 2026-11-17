import { calculateNetProfit, evaluateRisk } from "./index.js";
import type { ProfitInput, RiskLimits } from "./index.js";

export type DemoChannel = "MARKETPLACE" | "OWN_STORE" | "SOCIAL";
export type AssessmentStatus = "RECOMMENDED_FOR_REVIEW" | "NEEDS_REVIEW";

export type DemoProduct = {
  id: string;
  title: string;
  category: string;
  summary: string;
  demoOnly: true;
  currency: "EUR";
  stockUnits: number;
} & Omit<ProfitInput, "resalePriceCents"> & {
  resalePriceCents: bigint;
};

export type ProductAssessment = {
  product: DemoProduct;
  totalCostCents: bigint;
  netProfitCents: bigint;
  roiBasisPoints: bigint | null;
  riskReasons: string[];
  status: AssessmentStatus;
};

export type ListingDraft = {
  id: string;
  productId: string;
  channel: DemoChannel;
  channelLabel: string;
  title: string;
  description: string;
  status: "DRAFT_ONLY";
  requiresHumanApproval: true;
  purchaseEnabled: false;
  publicationEnabled: false;
};

export type ReachRecommendation = {
  productId: string;
  channel: DemoChannel;
  channelLabel: string;
  fit: "HIGH" | "MEDIUM";
  illustrativeWeeklyViews: { min: number; max: number };
  estimateKind: "SCENARIO_ONLY_NOT_A_FORECAST";
  rationale: string;
};

export type ApprovalQueueItem = {
  id: string;
  kind: "LISTING_DRAFT";
  status: "PENDING_HUMAN_REVIEW";
  message: string;
  externalActionTaken: false;
};

export type DemoAutopilotRun = {
  source: "LOCAL_DEMO_DATA";
  mode: "PAPER";
  liveTradingEnabled: false;
  externalCalls: 0;
  purchasesEnabled: false;
  publicationEnabled: false;
  assessments: ProductAssessment[];
  listingDrafts: ListingDraft[];
  reachRecommendations: ReachRecommendation[];
  approvalQueue: ApprovalQueueItem[];
};

export const DEMO_RISK_LIMITS: RiskLimits = {
  maxTradeCents: 20_000n,
  maxOpenTrades: 5,
  maxDailyLossCents: 5_000n,
  minProfitCents: 250n,
  minRoiBasisPoints: 1_500n,
};

/** Static illustrative inventory; this module deliberately has no provider or network client. */
export const DEMO_PRODUCTS: DemoProduct[] = [
  {
    id: "demo-organizer-set",
    title: "Kabel-Organizer-Set",
    category: "Schreibtisch-Zubehör",
    summary: "Demo-Set mit wiederverwendbaren Clips und Kabelbindern.",
    demoOnly: true,
    currency: "EUR",
    stockUnits: 18,
    buyPriceCents: 500n,
    inboundShippingCents: 70n,
    outboundShippingCents: 250n,
    marketplaceFeeCents: 150n,
    paymentFeeCents: 50n,
    packagingCents: 40n,
    riskReserveCents: 30n,
    resalePriceCents: 1_799n,
  },
  {
    id: "demo-desk-light",
    title: "Kompakte Schreibtischleuchte",
    category: "Wohnen & Büro",
    summary: "Fiktiver Demo-Kandidat; technische Produktangaben sind nicht verifiziert.",
    demoOnly: true,
    currency: "EUR",
    stockUnits: 7,
    buyPriceCents: 2_100n,
    inboundShippingCents: 200n,
    outboundShippingCents: 450n,
    marketplaceFeeCents: 320n,
    paymentFeeCents: 110n,
    packagingCents: 80n,
    riskReserveCents: 150n,
    resalePriceCents: 4_699n,
  },
  {
    id: "demo-cable-clips",
    title: "Kabelclip-Mix",
    category: "Schreibtisch-Zubehör",
    summary: "Demo-Kandidat mit knapp kalkuliertem Beispielpreis.",
    demoOnly: true,
    currency: "EUR",
    stockUnits: 30,
    buyPriceCents: 600n,
    inboundShippingCents: 90n,
    outboundShippingCents: 230n,
    marketplaceFeeCents: 180n,
    paymentFeeCents: 50n,
    packagingCents: 40n,
    riskReserveCents: 100n,
    resalePriceCents: 1_499n,
  },
];

const CHANNELS: Array<{
  channel: DemoChannel;
  label: string;
  fit: "HIGH" | "MEDIUM";
  weeklyViews: { min: number; max: number };
  rationale: string;
}> = [
  {
    channel: "MARKETPLACE",
    label: "Marktplatz",
    fit: "HIGH",
    weeklyViews: { min: 80, max: 240 },
    rationale: "Demo-Idee: klare Produkttitel und vergleichbare Merkmale hervorheben.",
  },
  {
    channel: "OWN_STORE",
    label: "Eigener Shop",
    fit: "MEDIUM",
    weeklyViews: { min: 30, max: 110 },
    rationale: "Demo-Idee: Produkt mit passenden Ergänzungen in einer Themenkollektion zeigen.",
  },
  {
    channel: "SOCIAL",
    label: "Social",
    fit: "MEDIUM",
    weeklyViews: { min: 120, max: 360 },
    rationale: "Demo-Idee: einen kurzen Anwendungsfall als redaktionellen Beitrag erklären.",
  },
];

export function assessDemoProduct(
  product: DemoProduct,
  limits: RiskLimits = DEMO_RISK_LIMITS,
): ProductAssessment {
  const profit = calculateNetProfit(product);
  const riskReasons = evaluateRisk(
    {
      totalCostCents: profit.totalCostCents,
      expectedProfitCents: profit.netProfitCents,
      roiBasisPoints: profit.roiBasisPoints,
      openTrades: 0,
      dailyLossCents: 0n,
    },
    limits,
  );
  if (product.stockUnits <= 0) riskReasons.push("DEMO_STOCK_UNAVAILABLE");
  return {
    product,
    totalCostCents: profit.totalCostCents,
    netProfitCents: profit.netProfitCents,
    roiBasisPoints: profit.roiBasisPoints,
    riskReasons,
    status: riskReasons.length === 0 ? "RECOMMENDED_FOR_REVIEW" : "NEEDS_REVIEW",
  };
}

export function createListingDraft(
  product: DemoProduct,
  channel: DemoChannel = "MARKETPLACE",
): ListingDraft {
  const channelDetails = CHANNELS.find((item) => item.channel === channel)!;
  const channelDescription: Record<DemoChannel, string> = {
    MARKETPLACE: "Fokus: präzise Suchbegriffe und klar gegliederte Produktmerkmale.",
    OWN_STORE: "Fokus: Einordnung in eine passende Themenkollektion des eigenen Shops.",
    SOCIAL: "Fokus: kurze redaktionelle Anwendungsidee, ohne unbelegte Leistungsversprechen.",
  };
  return {
    id: `draft-${product.id}-${channel.toLowerCase()}`,
    productId: product.id,
    channel,
    channelLabel: channelDetails.label,
    title: product.title,
    description: `${product.summary} ${channelDescription[channel]} Bitte Verfügbarkeit, Eigenschaften, Versandkosten und alle Angaben vor einer Veröffentlichung eigenständig verifizieren. Demo-Entwurf – keine Anbieterprüfung durchgeführt.`,
    status: "DRAFT_ONLY",
    requiresHumanApproval: true,
    purchaseEnabled: false,
    publicationEnabled: false,
  };
}

export function planDemoReach(product: DemoProduct): ReachRecommendation[] {
  return CHANNELS.map((channel) => ({
    productId: product.id,
    channel: channel.channel,
    channelLabel: channel.label,
    fit: channel.fit,
    illustrativeWeeklyViews: { ...channel.weeklyViews },
    estimateKind: "SCENARIO_ONLY_NOT_A_FORECAST",
    rationale: `${channel.rationale} Die Reichweitenspanne ist rein illustrativ und nicht gemessen.`,
  }));
}

/** Runs a pure local demo pipeline; it cannot call a provider, buy, publish, or approve. */
export function runDemoAutopilot(
  products: DemoProduct[] = DEMO_PRODUCTS,
  limits: RiskLimits = DEMO_RISK_LIMITS,
): DemoAutopilotRun {
  const assessments = products.map((product) => assessDemoProduct(product, limits));
  const reviewable = assessments.filter((item) => item.riskReasons.length === 0);
  const listingDrafts = reviewable.flatMap((item) =>
    CHANNELS.map((channel) => createListingDraft(item.product, channel.channel)),
  );
  const reachRecommendations = reviewable.flatMap((item) => planDemoReach(item.product));
  const approvalQueue = listingDrafts.map((draft) => ({
    id: `approval-${draft.id}`,
    kind: "LISTING_DRAFT" as const,
    status: "PENDING_HUMAN_REVIEW" as const,
    message: `Listing-Entwurf für „${draft.title}“ wartet auf manuelle Prüfung.`,
    externalActionTaken: false as const,
  }));

  return {
    source: "LOCAL_DEMO_DATA",
    mode: "PAPER",
    liveTradingEnabled: false,
    externalCalls: 0,
    purchasesEnabled: false,
    publicationEnabled: false,
    assessments,
    listingDrafts,
    reachRecommendations,
    approvalQueue,
  };
}
