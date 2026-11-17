import { describe, expect, it } from "vitest";
import {
  DEMO_PRODUCTS,
  assessDemoProduct,
  createListingDraft,
  planDemoReach,
  runDemoAutopilot,
} from "./autopilot";

describe("safe demo autopilot", () => {
  it("uses the real integer-cent profit and risk primitives", () => {
    const assessment = assessDemoProduct(DEMO_PRODUCTS[0]!);
    expect(assessment.totalCostCents).toBe(1_090n);
    expect(assessment.netProfitCents).toBe(709n);
    expect(assessment.status).toBe("RECOMMENDED_FOR_REVIEW");
    expect(assessment.product.demoOnly).toBe(true);
  });

  it("does not draft products rejected by configured risk limits", () => {
    const run = runDemoAutopilot();
    const rejected = run.assessments.find((item) => item.product.id === "demo-cable-clips");
    expect(rejected?.riskReasons).toContain("MIN_PROFIT_NOT_MET");
    expect(run.listingDrafts.some((draft) => draft.productId === "demo-cable-clips")).toBe(false);
  });

  it("creates unposted listing drafts that explicitly require human review", () => {
    const draft = createListingDraft(DEMO_PRODUCTS[0]!, "MARKETPLACE");
    expect(draft.status).toBe("DRAFT_ONLY");
    expect(draft.channel).toBe("MARKETPLACE");
    expect(draft.channelLabel).toBe("Marktplatz");
    expect(draft.requiresHumanApproval).toBe(true);
    expect(draft.purchaseEnabled).toBe(false);
    expect(draft.publicationEnabled).toBe(false);
    expect(draft.description).toContain("präzise Suchbegriffe");
    expect(draft.description).toContain("vor einer Veröffentlichung eigenständig verifizieren");
  });

  it("creates separate channel-specific drafts and approval items", () => {
    const run = runDemoAutopilot();
    const organizerDrafts = run.listingDrafts.filter((draft) => draft.productId === "demo-organizer-set");
    expect(organizerDrafts.map((draft) => draft.channel)).toEqual(["MARKETPLACE", "OWN_STORE", "SOCIAL"]);
    expect(new Set(organizerDrafts.map((draft) => draft.description)).size).toBe(3);
    expect(run.approvalQueue).toHaveLength(run.listingDrafts.length);
  });

  it("marks reach spans as illustrative scenarios, not measured forecasts", () => {
    const recommendations = planDemoReach(DEMO_PRODUCTS[0]!);
    expect(recommendations).toHaveLength(3);
    expect(recommendations.every((item) => item.estimateKind === "SCENARIO_ONLY_NOT_A_FORECAST")).toBe(true);
    expect(recommendations.every((item) => item.rationale.includes("nicht gemessen"))).toBe(true);
  });

  it("keeps the entire run local, paper-only, and pending human approval", () => {
    const run = runDemoAutopilot();
    expect(run.source).toBe("LOCAL_DEMO_DATA");
    expect(run.mode).toBe("PAPER");
    expect(run.liveTradingEnabled).toBe(false);
    expect(run.externalCalls).toBe(0);
    expect(run.purchasesEnabled).toBe(false);
    expect(run.publicationEnabled).toBe(false);
    expect(run.approvalQueue).toHaveLength(run.listingDrafts.length);
    expect(run.approvalQueue.every((item) => item.status === "PENDING_HUMAN_REVIEW")).toBe(true);
    expect(run.approvalQueue.every((item) => item.externalActionTaken === false)).toBe(true);
  });
});
