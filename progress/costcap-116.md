# costcap-116 (CC-5): shared caps across concurrent wrappers on one host

`costcap wrap --shared-ledger` shares day/month caps between wrappers on one host through a per-call critical section in `src/ledger-lock.js`. Tests: `test/ledger-shared.test.js`. HANDOFF portable modules updated.
