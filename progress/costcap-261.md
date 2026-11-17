# costcap-261: weekly caps for hosted agents and teams (2026-11-16)

- Feature landed on main in `d7180a1` (period week keys, agent `caps.week`, team `week`, wrapper cached verdicts, alerts, dashboard, README).
- This follow-up adds the HANDOFF portable-module row and this fragment, and closes #261.
- Targeted tests green: week-cap, period, agent-budget, hosted-teams, alerts, dashboard-hour-cap, agent-spend (75 pass).
- Out of scope (per issue): local `wrap --week-cap`, week scope for tag/model/org caps and raises, `cap_projected` for weeks.
