import type { TestnetKillSwitchScope, TestnetKillSwitchState } from "@prisma/client";

export type KillSwitchRecord = { id: string; scope: TestnetKillSwitchScope; scopeKey: string; state: TestnetKillSwitchState; reason: string; version: number };
export type KillSwitchStore = {
  findUnique(args: { where: { scope_scopeKey: { scope: TestnetKillSwitchScope; scopeKey: string } } }): Promise<KillSwitchRecord | null>;
  updateMany(args: { where: { scope_scopeKey: { scope: TestnetKillSwitchScope; scopeKey: string }; version: number }; data: { state: TestnetKillSwitchState; reason: string; version: { increment: number }; triggeredBy?: string } }): Promise<{ count: number }>;
};
export type KillSwitchAuditHook = (event: { scope: TestnetKillSwitchScope; scopeKey: string; state: TestnetKillSwitchState; version: number }) => Promise<void>;

/** TESTNET-only: reads fail closed and writes require the observed version. */
export async function readKillSwitch(store: Pick<KillSwitchStore, "findUnique">, scope: TestnetKillSwitchScope, scopeKey: string): Promise<KillSwitchRecord> {
  const record = await store.findUnique({ where: { scope_scopeKey: { scope, scopeKey } } });
  if (!record) throw new Error("TESTNET_KILL_SWITCH_MISSING");
  return record;
}
export async function transitionKillSwitch(store: KillSwitchStore, input: { scope: TestnetKillSwitchScope; scopeKey: string; expectedVersion: number; state: TestnetKillSwitchState; reason: string; actor?: string; audit?: KillSwitchAuditHook }): Promise<KillSwitchRecord> {
  if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 1 || !input.reason.trim()) throw new Error("KILL_SWITCH_INPUT_INVALID");
  const result = await store.updateMany({ where: { scope_scopeKey: { scope: input.scope, scopeKey: input.scopeKey }, version: input.expectedVersion }, data: { state: input.state, reason: input.reason.slice(0, 500), version: { increment: 1 }, ...(input.actor ? { triggeredBy: input.actor } : {}) } });
  if (result.count !== 1) throw new Error("KILL_SWITCH_VERSION_CONFLICT");
  const updated = await readKillSwitch(store, input.scope, input.scopeKey);
  await input.audit?.({ scope: updated.scope, scopeKey: updated.scopeKey, state: updated.state, version: updated.version });
  return updated;
}
