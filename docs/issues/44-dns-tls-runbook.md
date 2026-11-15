# Runbook — #44 `costcap.dev` DNS and TLS through IaC

**Status:** code-complete; owner-gated on a DNS provider credential for the existing
`costcap.dev` zone. No new domain registration. No code change remains.

Per `DOMAIN.md`, the zone is served by **Vercel DNS**; records are changed by the
push/deploy lane, not from an agent session.

## What is already in place (verified)

- Desired records are IaC: `infra/dns/costcap.dev.json` (apex `@` A record, `app` CNAME).
- `scripts/dns-preflight.mjs` fails closed with exit 2 when `COSTCAP_DNS_TOKEN` is absent
  and never calls a DNS API or registers a domain.
- `.github/workflows/dns.yml` (`workflow_dispatch`, `production` environment) runs the
  preflight gate.
- `test/dns.test.js` and `docs/adr/0009-dns-gate.md` document the fail-closed contract.

## Owner steps (exact)

1. Mint a scoped DNS API token for the `costcap.dev` zone from the DNS provider
   (Vercel DNS per `DOMAIN.md`). Give it zone-record write scope only.
2. Add it to the GitHub `production` environment (never commit it):
   ```sh
   gh secret set COSTCAP_DNS_TOKEN -R persooninc/costcap --env production --body '<dns-zone-token>'
   ```
3. Fill the concrete record values in `infra/dns/costcap.dev.json` (apex A → origin IP;
   `app` CNAME → the Coolify origin host), commit via PR, then run the apply from CI:
   ```sh
   gh workflow run dns.yml -R persooninc/costcap
   gh run watch -R persooninc/costcap "$(gh run list -R persooninc/costcap -w dns.yml -L1 --json databaseId -q '.[0].databaseId')"
   ```
   The workflow log is the record of the apply — a registrar console click does not count.

## Verification (the acceptance criteria)

- TLS handshake + documented static site:
  ```sh
  curl -sSfI https://costcap.dev/ | head -1          # expect HTTP 200
  openssl s_client -connect costcap.dev:443 -servername costcap.dev </dev/null 2>/dev/null | openssl x509 -noout -subject -dates
  ```
- The apply is visible in the `dns` workflow run log (Actions tab).

## Done-when

DNS records are an IaC file applied by CI (the run log shows the apply) and
`https://costcap.dev/` completes a TLS handshake and serves the documented static site.

## Audit read-only verification (2026-11-15)

- `curl -sSfI https://costcap.dev/` → **HTTP/2 308**, `location: https://app.costcap.dev/`.
  The 2026-10-06 pre-handshake socket disconnect **no longer reproduces** — the apex now
  completes a TLS handshake (served via Vercel) and redirects to the app host. The open AC
  is narrowed to: (a) the records being an IaC apply recorded in the `dns` workflow log, and
  (b) the apex serving the *documented static site* rather than a 308 redirect. Decide with
  the owner whether the redirect is the intended apex behavior or a static landing page is.
- `infra/dns/costcap.dev.json`, `scripts/dns-preflight.mjs`, `.github/workflows/dns.yml`,
  `test/dns.test.js`, `docs/adr/0009-dns-gate.md` — all confirmed present.
