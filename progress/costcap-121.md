# costcap-121: per-org alert destinations

Done. Landed in 7f869fa on main: `GET/POST /v1/alert-settings` (members read masked, owner/admin write; emails must be verified members, webhook must be `https://hooks.slack.com/services/...`), webhook stored masked-only in responses/audit, `alert_settings.change` audit, worker routes per org via `createOrgAlertRouter` (env `COSTCAP_ALERT_ORG_ID` kept as fallback), dashboard card. Follow-up commit adds the HANDOFF portable-module row and this fragment. No infra changes.
