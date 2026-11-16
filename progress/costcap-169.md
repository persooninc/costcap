# costcap-169: cost attribution tags (2026-11-16)

- `src/tags.js`: tag rules, header parse, merge (wrapper wins), ingest validation, CSV cell.
- Proxy strips `x-costcap-tag`, stamps `tags` on every receipt of the request (incl. blocked, unknown-cost, batch); malformed header: 400 `invalid_tags`, $0 receipt, not forwarded.
- `wrap --tag k=v` (repeatable, exit 2 on bad tag); `receipts --tag`; `tags` CSV column local + hosted.
- Hosted: `POST /v1/receipts` validates tags; `GET /v1/spend?group_by=tag&tag_key=K`; Spend card "By tag".
- Tests: test/tags.test.js, test/proxy.test.js (#169 cases), e2e/spend.spec.js; CSV header tests updated.
