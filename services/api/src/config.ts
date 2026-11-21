import { loadTestnetRuntimeConfig } from "./testnet-config.js";

export type TradingMode = "AUTONOMOUS";

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error("Expected boolean environment value");
}

const requestedMode = process.env.TRADING_MODE ?? "AUTONOMOUS";
if (requestedMode !== "AUTONOMOUS") throw new Error("TRADING_MODE must be AUTONOMOUS");
if (parseBoolean(process.env.LIVE_TRADING_ENABLED, false)) {
  throw new Error("Mutating marketplace execution requires a reviewed provider adapter");
}
const testnetRuntimeConfig = loadTestnetRuntimeConfig();
if (testnetRuntimeConfig.enabled) {
  throw new Error("TESTNET execution is not enabled in this release");
}

export const config = Object.freeze({
  host: process.env.HOST ?? "0.0.0.0",
  port: Number(process.env.PORT ?? 8080),
  tradingMode: "AUTONOMOUS" as const,
  liveTradingEnabled: false as const,
  testnetEnabled: false as const,
  emergencyStop: parseBoolean(process.env.EMERGENCY_STOP, true),
});

if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) {
  throw new Error("PORT must be a valid TCP port");
}
