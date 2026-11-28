# costcap-267 (#267)

- Previous-month unknown receipts in the current ISO week no longer refuse month/day-only agents, teams, org, or the wrapper's cached fleet verdict; week caps still refuse (#261 AC6).
- Legacy unknown `caps.*` keys: dropped by a one-time audited startup migration and tolerated by the wrapper cache/fetch; kill switch works again. New writes still 400.
- Tests: agent-budget, team-budget, fleet-client, hosted-server (#267), week-cap AC6 updated for the week flag.
