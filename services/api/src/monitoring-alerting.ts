export type AlertSeverity = "INFO" | "WARNING" | "CRITICAL";
export type ProviderStatus = "HEALTHY" | "DEGRADED" | "UNAVAILABLE" | "UNKNOWN";
export type AlertCode = "KILL_SWITCH_ACTIVE" | "UNKNOWN_ORDERS" | "RECONCILIATION_STALE" | "RECONCILIATION_FAILED" | "PROVIDER_UNAVAILABLE" | "PROVIDER_DEGRADED" | "DRAWDOWN_LIMIT";

export type MonitoringSnapshot = {
  observedAt: string;
  killSwitches: readonly { scope: string; state: "ARMED" | "TRIGGERED" | "DRAINING" | "HALTED" }[];
  unknownOrderCount: number;
  providerStatus: ProviderStatus;
  reconciliation: { status: "CLEAN" | "RUNNING" | "HALT_REQUIRED" | "FAILED"; lastSuccessfulAt: string | null };
  drawdownBasisPoints: number;
};

export type MonitoringPolicy = {
  maxReconciliationAgeMs: number;
  maxDrawdownBasisPoints: number;
};

export type MonitoringAlert = {
  code: AlertCode;
  severity: AlertSeverity;
  fingerprint: string;
  observedAt: string;
  title: string;
  message: string;
};

function validatePolicy(policy: MonitoringPolicy): void {
  if (!Number.isInteger(policy.maxReconciliationAgeMs) || policy.maxReconciliationAgeMs < 1 || policy.maxReconciliationAgeMs > 7 * 24 * 60 * 60 * 1000) throw new Error("MONITORING_RECONCILIATION_AGE_INVALID");
  if (!Number.isInteger(policy.maxDrawdownBasisPoints) || policy.maxDrawdownBasisPoints < 0 || policy.maxDrawdownBasisPoints > 10_000) throw new Error("MONITORING_DRAWDOWN_LIMIT_INVALID");
}

function alert(code: AlertCode, severity: AlertSeverity, observedAt: string, title: string, message: string): MonitoringAlert {
  return { code, severity, fingerprint: `${code}:${severity}`, observedAt, title, message };
}

export function evaluateMonitoringSnapshot(snapshot: MonitoringSnapshot, policy: MonitoringPolicy, now = new Date(snapshot.observedAt)): readonly MonitoringAlert[] {
  validatePolicy(policy);
  if (!Number.isFinite(now.getTime()) || !Number.isFinite(Date.parse(snapshot.observedAt))) throw new Error("MONITORING_TIMESTAMP_INVALID");
  if (!Number.isInteger(snapshot.unknownOrderCount) || snapshot.unknownOrderCount < 0) throw new Error("MONITORING_UNKNOWN_ORDER_COUNT_INVALID");
  if (!Number.isFinite(snapshot.drawdownBasisPoints) || snapshot.drawdownBasisPoints < 0) throw new Error("MONITORING_DRAWDOWN_INVALID");
  const alerts: MonitoringAlert[] = [];
  const activeSwitch = snapshot.killSwitches.find((item) => item.state !== "ARMED");
  if (activeSwitch) alerts.push(alert("KILL_SWITCH_ACTIVE", "CRITICAL", snapshot.observedAt, "Kill-Switch aktiv", `Scope ${activeSwitch.scope} steht auf ${activeSwitch.state}. Neue Aktionen bleiben blockiert.`));
  if (snapshot.unknownOrderCount > 0) alerts.push(alert("UNKNOWN_ORDERS", "CRITICAL", snapshot.observedAt, "Unbekannte Orders", `${snapshot.unknownOrderCount} Order(s) benötigen Reconciliation.`));
  if (snapshot.providerStatus === "UNAVAILABLE" || snapshot.providerStatus === "UNKNOWN") alerts.push(alert("PROVIDER_UNAVAILABLE", "CRITICAL", snapshot.observedAt, "Provider nicht verfügbar", "Der Providerstatus ist nicht sicher; mutierende Aktionen bleiben blockiert."));
  else if (snapshot.providerStatus === "DEGRADED") alerts.push(alert("PROVIDER_DEGRADED", "WARNING", snapshot.observedAt, "Provider eingeschränkt", "Der Provider meldet einen eingeschränkten Zustand."));
  if (snapshot.reconciliation.status === "HALT_REQUIRED" || snapshot.reconciliation.status === "FAILED") alerts.push(alert("RECONCILIATION_FAILED", "CRITICAL", snapshot.observedAt, "Reconciliation fehlgeschlagen", "Reconciliation verlangt Halt und manuelle Prüfung."));
  const lastReconciliation = snapshot.reconciliation.lastSuccessfulAt === null ? NaN : Date.parse(snapshot.reconciliation.lastSuccessfulAt);
  const age = Number.isFinite(lastReconciliation) ? now.getTime() - lastReconciliation : Infinity;
  if (age > policy.maxReconciliationAgeMs) alerts.push(alert("RECONCILIATION_STALE", age > policy.maxReconciliationAgeMs * 2 ? "CRITICAL" : "WARNING", snapshot.observedAt, "Reconciliation veraltet", "Es liegt kein ausreichend aktueller erfolgreicher Reconciliation-Lauf vor."));
  if (snapshot.drawdownBasisPoints >= policy.maxDrawdownBasisPoints) alerts.push(alert("DRAWDOWN_LIMIT", "CRITICAL", snapshot.observedAt, "Drawdown-Limit erreicht", `Drawdown ${snapshot.drawdownBasisPoints} bps überschreitet das Limit.`));
  return alerts;
}

export class AlertDeduper {
  private readonly lastSent = new Map<string, number>();
  constructor(private readonly cooldownMs = 15 * 60 * 1000) {
    if (!Number.isInteger(cooldownMs) || cooldownMs < 0) throw new Error("ALERT_DEDUP_COOLDOWN_INVALID");
  }
  accept(alert: MonitoringAlert, now = Date.now()): boolean {
    const last = this.lastSent.get(alert.fingerprint);
    if (last !== undefined && now - last < this.cooldownMs) return false;
    this.lastSent.set(alert.fingerprint, now);
    return true;
  }
}

export interface AlertTransport {
  readonly channel: "TELEGRAM" | "DISCORD";
  send(alert: MonitoringAlert): Promise<void>;
}

export type AlertingRuntimeConfig = {
  enabled: boolean;
  telegram: { botToken: string; chatId: string } | null;
  discord: { webhookUrl: string } | null;
};

function booleanEnv(value: string | undefined): boolean {
  if (value === undefined || value === "false") return false;
  if (value === "true") return true;
  throw new Error("ALERTING_ENABLED must be true or false");
}

function validateDiscordWebhook(value: string): string {
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new Error("DISCORD_WEBHOOK_URL must be a valid URL"); }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash || !["discord.com", "discordapp.com"].includes(parsed.hostname.toLowerCase()) || !parsed.pathname.startsWith("/api/webhooks/")) throw new Error("DISCORD_WEBHOOK_URL is not an allowed Discord webhook");
  return parsed.toString();
}

export function loadAlertingRuntimeConfig(env: NodeJS.ProcessEnv = process.env): AlertingRuntimeConfig {
  if (!booleanEnv(env.ALERTING_ENABLED)) return { enabled: false, telegram: null, discord: null };
  const telegramToken = env.TELEGRAM_BOT_TOKEN?.trim();
  const telegramChatId = env.TELEGRAM_CHAT_ID?.trim();
  if ((telegramToken && !telegramChatId) || (!telegramToken && telegramChatId)) throw new Error("TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must be configured together");
  if (telegramToken && (telegramToken.length < 16 || /\s/.test(telegramToken))) throw new Error("TELEGRAM_BOT_TOKEN is invalid");
  if (telegramChatId && (telegramChatId.length > 128 || /[\r\n]/.test(telegramChatId))) throw new Error("TELEGRAM_CHAT_ID is invalid");
  const discord = env.DISCORD_WEBHOOK_URL?.trim() ? { webhookUrl: validateDiscordWebhook(env.DISCORD_WEBHOOK_URL.trim()) } : null;
  if (!telegramToken && !discord) throw new Error("At least one alert channel must be configured");
  return { enabled: true, telegram: telegramToken && telegramChatId ? { botToken: telegramToken, chatId: telegramChatId } : null, discord };
}

function formatAlert(alert: MonitoringAlert): string {
  return `[${alert.severity}] ${alert.title}\n${alert.message}\nCode: ${alert.code}`;
}

async function postJson(fetchImpl: typeof fetch, url: string, body: unknown, channel: string): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetchImpl(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(body), redirect: "error", signal: controller.signal });
    if (!response.ok) throw new Error(`ALERT_${channel}_HTTP_${response.status}`);
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`ALERT_${channel}_TIMEOUT`);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export class TelegramAlertTransport implements AlertTransport {
  readonly channel = "TELEGRAM" as const;
  constructor(private readonly botToken: string, private readonly chatId: string, private readonly fetchImpl: typeof fetch = fetch) {}
  async send(alert: MonitoringAlert): Promise<void> {
    await postJson(this.fetchImpl, `https://api.telegram.org/bot${this.botToken}/sendMessage`, { chat_id: this.chatId, text: formatAlert(alert), disable_web_page_preview: true }, "TELEGRAM");
  }
}

export class DiscordAlertTransport implements AlertTransport {
  readonly channel = "DISCORD" as const;
  constructor(private readonly webhookUrl: string, private readonly fetchImpl: typeof fetch = fetch) {
    validateDiscordWebhook(webhookUrl);
  }
  async send(alert: MonitoringAlert): Promise<void> {
    await postJson(this.fetchImpl, this.webhookUrl, { content: formatAlert(alert), allowed_mentions: { parse: [] } }, "DISCORD");
  }
}

export function createAlertTransports(config: AlertingRuntimeConfig, fetchImpl: typeof fetch = fetch): readonly AlertTransport[] {
  if (!config.enabled) return [];
  return [
    ...(config.telegram ? [new TelegramAlertTransport(config.telegram.botToken, config.telegram.chatId, fetchImpl)] : []),
    ...(config.discord ? [new DiscordAlertTransport(config.discord.webhookUrl, fetchImpl)] : []),
  ];
}

export async function dispatchMonitoringAlerts(alerts: readonly MonitoringAlert[], transports: readonly AlertTransport[], deduper = new AlertDeduper(), now = Date.now()): Promise<{ sent: number; suppressed: number; failed: number }> {
  let sent = 0;
  let suppressed = 0;
  let failed = 0;
  for (const item of alerts) {
    if (!deduper.accept(item, now)) { suppressed += transports.length; continue; }
    for (const transport of transports) {
      try { await transport.send(item); sent += 1; } catch { failed += 1; }
    }
  }
  return { sent, suppressed, failed };
}
