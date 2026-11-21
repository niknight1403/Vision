import { describe, expect, it, vi } from "vitest";
import { readKillSwitch, transitionKillSwitch, type KillSwitchStore } from "./testnet-kill-switch-service.js";
const record = { id: "k1", scope: "GLOBAL" as const, scopeKey: "all", state: "ARMED" as const, reason: "initial", version: 2 };
function store(overrides: Partial<KillSwitchStore> = {}): KillSwitchStore {
  return { findUnique: vi.fn(async () => record), updateMany: vi.fn(async () => ({ count: 1 })), ...overrides } as KillSwitchStore;
}
describe("testnet kill switch service", () => {
  it("fails closed when the persistent record is missing", async () => { await expect(readKillSwitch(store({ findUnique: vi.fn(async () => null) }), "GLOBAL", "all")).rejects.toThrow("TESTNET_KILL_SWITCH_MISSING"); });
  it("uses optimistic concurrency and emits an audit event", async () => {
    const db = store(); const audit = vi.fn(async () => undefined);
    const result = await transitionKillSwitch(db, { scope: "GLOBAL", scopeKey: "all", expectedVersion: 2, state: "TRIGGERED", reason: "incident", audit });
    expect(db.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ version: 2 }) }));
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ version: 2 }));
    expect(result.scope).toBe("GLOBAL");
  });
  it("rejects a lost CAS race", async () => { await expect(transitionKillSwitch(store({ updateMany: vi.fn(async () => ({ count: 0 })) }), { scope: "GLOBAL", scopeKey: "all", expectedVersion: 2, state: "HALTED", reason: "race" })).rejects.toThrow("KILL_SWITCH_VERSION_CONFLICT"); });
});
