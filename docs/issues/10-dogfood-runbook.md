# Runbook — #10 Dogfood on our own agent fleet (M1–M2)

**Status:** epic; owner-gated on an authorized workload + 14 consecutive days of real
receipts. No code slice remains — the dashboard already attaches per-agent UTC
day/month/all estimated spend and reconciles unknown-cost receipts. Do not invent receipts.
No customer organization is enrolled for this dogfood.

## What is already in place (verified)

- The wrap/meter/cap/kill CLI and proxy ship from source (epic #1, closed).
- Per-agent spend view, receipt sync, and unknown-cost reconciliation are built and tested
  (`test/agent-budget.test.js`, `test/reconcile.test.js`, `test/receipts-csv.test.js`).

## Owner steps (exact) — the 14-day dogfood

1. Pick one owner-authorized internal agent (e.g. NightlyQA). No customer org.
2. Wrap it with CostCap in front of its proxy-routed traffic:
   ```sh
   npx costcap wrap --day-cap <USD> --month-cap <USD> -- <nightlyqa command>
   ```
   Confirm `costcap check` is in that agent's CI if applicable.
3. Let it run for **14 consecutive calendar days**. Each day, review receipts:
   ```sh
   costcap receipts --since 14d --agent nightlyqa
   costcap receipts --export csv --since 14d > dogfood-receipts.csv
   ```
4. Reconcile every unknown-cost receipt (a provider/model the pricing table does not yet
   price) — either map it to a real rate via a pricing-table PR, or leave the wrap
   **stopped** for that path. Do not estimate past an unknown.

## Verification (the acceptance criteria)

- An owner-authorized agent is wrapped with CostCap (command above in place).
- Receipts for 14 consecutive days are stored and reviewed (the CSV export + daily review
  notes).
- Every unknown-cost receipt is reconciled, or the wrap stayed stopped for that path.
- No customer organization was enrolled (confirm the enrolled org is the internal one only).

## Done-when

14 consecutive days of real receipts from an owner-authorized agent are stored and
reviewed, unknown-cost receipts are reconciled or the wrap stayed stopped, and no customer
org was enrolled.

## Audit read-only verification (2026-11-15)

- Dogfood-relevant tests confirmed present on `main`: `test/agent-budget.test.js`,
  `test/reconcile.test.js`, `test/receipts-csv.test.js`. No code slice remains; this epic is
  an owner-operational 14-day real-receipt exercise (no customer org), nothing buildable here.
