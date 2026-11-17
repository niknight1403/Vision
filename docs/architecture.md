# Architecture

## Intended flow

Market Scout → Product Matcher → Demand/Profit Analysis → Risk Guardian → Approval Center → Execution Service → Reconciliation → Listing/Settlement → Learning.

The agents may discover and evaluate opportunities. They cannot independently change risk limits, grant permissions, disable the emergency stop, or authorize a purchase.

## Trust boundaries

- Mobile client: presentation and explicit administrator interactions only.
- API: authentication, authorization, validation, approvals, audit, risk enforcement.
- Execution service: rechecks approval, kill switch, price, stock, fees, limits, and idempotency immediately before provider calls.
- Marketplace adapters: declare capabilities individually. Search access does not imply checkout, listing, order status, or payout access.
- Ledger: immutable, append-only financial facts. Expected sales are not cash; revenue becomes available only after settlement.

## Financial invariants

Use integer cents/BigInt for calculations. PAPER and LIVE accounts must be isolated. Every reservation, purchase, fee, sale, refund, payout, and release must have a uniquely referenced ledger event. Unknown external states are reconciled, never blindly retried.

## Modes

PAPER is the default. LIVE remains disabled until provider integrations, permissions, financial controls, test evidence, and an explicit administrator enablement flow are complete.
