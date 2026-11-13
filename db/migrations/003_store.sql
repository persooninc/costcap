-- FA-CC-04: hosted store records with tenant isolation enforced by row-level security.
-- body is json, not jsonb, so the stored text (and key order) round-trips exactly.
-- seq keeps first-insert order so collections reload in the order the app created them.
CREATE TABLE store_records (
  seq bigint GENERATED ALWAYS AS IDENTITY,
  kind text NOT NULL,
  id text NOT NULL,
  org_id text NULL,
  body json NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (kind, id)
);
CREATE INDEX store_records_org ON store_records (org_id);

ALTER TABLE store_records ENABLE ROW LEVEL SECURITY;

-- Tenant rows: only under the matching app.org_id.
CREATE POLICY store_tenant ON store_records
  FOR ALL
  USING (org_id IS NOT NULL AND org_id = current_setting('app.org_id', true))
  WITH CHECK (org_id IS NOT NULL AND org_id = current_setting('app.org_id', true));

-- System rows (sessions, sign-in challenges, billing event ids): only under app.scope = 'system'.
CREATE POLICY store_system ON store_records
  FOR ALL
  USING (org_id IS NULL AND current_setting('app.scope', true) = 'system')
  WITH CHECK (org_id IS NULL AND current_setting('app.scope', true) = 'system');

-- Startup load: read-only, every row. No write policy uses this scope.
CREATE POLICY store_loader ON store_records
  FOR SELECT
  USING (current_setting('app.scope', true) = 'loader');

ALTER TABLE store_records OWNER TO costcap_migrate;
GRANT SELECT, INSERT, UPDATE, DELETE ON store_records TO costcap_app;
