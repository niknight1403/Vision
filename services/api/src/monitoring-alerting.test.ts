import { describe, expect, it, vi } from "vitest";
import {
  AlertDeduper,
  DiscordAlertTransport,
  dispatchMonitoringAlerts,
  evaluateMonitoringSnapshot,
  loadAlertingRuntimeConfig,
  TelegramAlertTransport,
  type MonitoringAlert,
} from "./monitoring-alerting.js";

const snapshot = {
  observedAt: "2026-11-17T04:00:00.000Z",
  killSwitches: [{ scope: "GLOBAL", state: "ARMED" as const }],
  unknownOrderCount: 0,
  providerStatus: "HEALTHY" as const,
  reconciliation: { status: "CLEAN" as const, lastSuccessfulAt: "2026-11-17T03:55:00.000Z" },
  drawdownBasisPoints: 100,
};

const alert: MonitoringAlert = {
  code: "UNKNOWN_ORDERS",
  severity: "CRITICAL",
  fingerprint: "UNKNOWN_ORDERS:CRITICAL",
  observedAt: snapshot.observedAt,
  title: "Unbekannte Orders",
  message: "1 Order benötigt Reconciliation.",
};

describe("monitoring alert rules", () => {
  it("raises critical alerts for safety conditions and stale reconciliation", () => {
    const alerts = evaluateMonitoringSnapshot({ ...snapshot, killSwitches: [{ scope: "ACCOUNT", state: "HALTED" }], unknownOrderCount: 2, providerStatus: "UNAVAILABLE", reconciliation: { status: "FAILED", lastSuccessfulAt: null }, drawdownBasisPoints: 500 }, { maxReconciliationAgeMs: 60_000, maxDrawdownBasisPoints: 400 });
    expect(alerts.map((item) => item.code)).toEqual(expect.arrayContaining(["KILL_SWITCH_ACTIVE", "UNKNOWN_ORDERS", "PROVIDER_UNAVAILABLE", "RECONCILIATION_FAILED", "RECONCILIATION_STALE", "DRAWDOWN_LIMIT"]));
    expect(alerts.every((item) => item.severity === "CRITICAL")).toBe(true);
  });

  it("keeps healthy snapshots quiet and validates policy/input boundaries", () => {
    expect(evaluateMonitoringSnapshot(snapshot, { maxReconciliationAgeMs: 600_000, maxDrawdownBasisPoints: 400 })).toEqual([]);
    expect(() => evaluateMonitoringSnapshot(snapshot, { maxReconciliationAgeMs: 0, maxDrawdownBasisPoints: 400 })).toThrow("AGE_INVALID");
    expect(() => evaluateMonitoringSnapshot({ ...snapshot, unknownOrderCount: -1 }, { maxReconciliationAgeMs: 600_000, maxDrawdownBasisPoints: 400 })).toThrow("COUNT_INVALID");
  });

  it("deduplicates the same alert during the cooldown", () => {
    const deduper = new AlertDeduper(1_000);
    expect(deduper.accept(alert, 10_000)).toBe(true);
    expect(deduper.accept(alert, 10_500)).toBe(false);
    expect(deduper.accept(alert, 11_000)).toBe(true);
  });
});

describe("Telegram and Discord alert transports", () => {
  it("defaults alerting to disabled and rejects partial or unsafe configuration", () => {
    expect(loadAlertingRuntimeConfig({})).toEqual({ enabled: false, telegram: null, discord: null });
    expect(() => loadAlertingRuntimeConfig({ ALERTING_ENABLED: "true" })).toThrow("At least one");
    expect(() => loadAlertingRuntimeConfig({ ALERTING_ENABLED: "true", TELEGRAM_BOT_TOKEN: "token-without-chat" })).toThrow("configured together");
    expect(() => loadAlertingRuntimeConfig({ ALERTING_ENABLED: "true", DISCORD_WEBHOOK_URL: "https://evil.example/api/webhooks/1" })).toThrow("allowed Discord");
    expect(() => loadAlertingRuntimeConfig({ ALERTING_ENABLED: "true", DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/1?secret=leak" })).toThrow("allowed Discord");
  });

  it("sends redacted structured payloads through both configured channels", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const body = JSON.parse(String(init?.body));
      expect(body.text ?? body.content).toContain("Unbekannte Orders");
      expect(JSON.stringify(body)).not.toContain("bot-secret");
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    });
    const config = loadAlertingRuntimeConfig({ ALERTING_ENABLED: "true", TELEGRAM_BOT_TOKEN: "1234567890:bot-secret-value", TELEGRAM_CHAT_ID: "-100123", DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/123/token" });
    const transports = [new TelegramAlertTransport(config.telegram!.botToken, config.telegram!.chatId, fetchMock), new DiscordAlertTransport(config.discord!.webhookUrl, fetchMock)];
    const result = await dispatchMonitoringAlerts([alert], transports);
    expect(result).toEqual({ sent: 2, suppressed: 0, failed: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0].toString()).toContain("api.telegram.org/bot");
    expect(fetchMock.mock.calls[1][0].toString()).toContain("discord.com/api/webhooks");
  });

  it("suppresses duplicate delivery and counts transport failures without throwing", async () => {
    const send = vi.fn(async () => { throw new Error("network"); });
    const result = await dispatchMonitoringAlerts([alert, alert], [{ channel: "DISCORD", send }], new AlertDeduper(60_000));
    expect(result).toEqual({ sent: 0, suppressed: 1, failed: 1 });
    expect(send).toHaveBeenCalledTimes(1);
  });
});
