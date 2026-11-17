import test from "node:test";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHostedServer } from "../src/hosted/server.js";
import { applyFile, psql } from "../scripts/db-migrate.mjs";
import { skipUnlessDocker } from "./support/docker.js";
import { startPostgres } from "./support/postgres.js";

const root = new URL("..", import.meta.url);
const file = (name) => new URL(name, root);

test("postgres migrations apply and roll back without changing the running store", { skip: skipUnlessDocker() }, async (t) => {
  const { container } = await startPostgres(t);
  applyFile(container, file("db/migrations/000_roles.sql"));
  psql(container, `BEGIN;\n${readFileSync(file("db/migrations/001_init.sql"))}\n${readFileSync(file("db/migrations/002_grants.sql"))}\nROLLBACK;`);
  assert.equal(psql(container, "SELECT to_regclass('public.orgs');").trim(), "");
  applyFile(container, file("db/migrations/001_init.sql"));
  applyFile(container, file("db/migrations/002_grants.sql"));
  assert.equal(psql(container, "SELECT r.rolname FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner WHERE c.relname = 'orgs';").trim(), "costcap_migrate");
  assert.equal(psql(container, "SELECT has_schema_privilege('costcap_app', 'public', 'CREATE');").trim(), "f");
  assert.equal(psql(container, "SELECT has_table_privilege('costcap_app', 'orgs', 'INSERT');").trim(), "t");
  const orgA = "11111111-1111-4111-8111-111111111111";
  const orgB = "22222222-2222-4222-8222-222222222222";
  const userA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const userB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  psql(container, `
    INSERT INTO orgs (id, name) VALUES ('${orgA}', 'A'), ('${orgB}', 'B');
    INSERT INTO users (id, org_id, email, role) VALUES
      ('${userA}', '${orgA}', 'a@example.test', 'owner'),
      ('${userB}', '${orgB}', 'b@example.test', 'owner');
  `);
  const asApp = (orgId, sql) => psql(container, `
    SET ROLE costcap_app;
    ${orgId ? `SET app.org_id = '${orgId}';` : "RESET app.org_id;"}
    ${sql}
  `).split("\n").map((line) => line.trim()).filter((line) => line && line !== "SET" && line !== "RESET");
  assert.deepEqual(asApp(orgA, "SELECT id FROM orgs ORDER BY id;"), [orgA]);
  assert.deepEqual(asApp(orgA, "SELECT id FROM users ORDER BY id;"), [userA]);
  assert.deepEqual(asApp(orgA, `UPDATE orgs SET name = 'hacked' WHERE id = '${orgB}';`), ["UPDATE 0"]);
  assert.deepEqual(asApp(orgA, `DELETE FROM users WHERE id = '${userB}';`), ["DELETE 0"]);
  assert.throws(() => asApp(orgA, `INSERT INTO orgs (id, name) VALUES ('${orgB}', 'stolen');`));
  assert.throws(() => asApp(orgA, `UPDATE users SET org_id = '${orgB}' WHERE id = '${userA}';`));
  const unset = (sql) => psql(container, `SET ROLE costcap_app;\n${sql}`).split("\n").map((line) => line.trim()).filter((line) => line && line !== "SET");
  assert.deepEqual(unset("SELECT count(*) FROM orgs;"), ["0"]);
  assert.deepEqual(unset("SELECT count(*) FROM users;"), ["0"]);
  assert.equal(psql(container, "SELECT name FROM orgs WHERE id = '" + orgB + "';").trim(), "B");
  applyFile(container, file("db/migrations/001_init.down.sql"));
  assert.equal(psql(container, "SELECT to_regclass('public.orgs');").trim(), "");
  // FA-CC-04: the service reads only the application-role URL; the migration URL stays with scripts/db-apply.mjs.
  const run = readFileSync(file("src/hosted/run.js"), "utf8");
  assert.equal(run.includes("COSTCAP_DATABASE_URL"), true);
  assert.equal(run.includes("MIGRATE_DATABASE_URL"), false);
  const service = createHostedServer({
    storePath: join(mkdtempSync(join(tmpdir(), "cc-health-")), "store.json"),
    origin: "http://localhost",
    secureCookies: false,
    verifyChallenge: async () => false,
    sendCode: async () => {},
  });
  t.after(() => { service.server.closeAllConnections(); service.server.close(); });
  await new Promise((resolve) => service.server.listen(0, "127.0.0.1", resolve));
  const health = await fetch(`http://127.0.0.1:${service.server.address().port}/health`);
  assert.equal((await health.json()).persistence, "single-process-file");
});

test("regression: postgres readiness wait is a deadline, not a fixed attempt count", { skip: skipUnlessDocker() }, async (t) => {
  const prev = process.env.COSTCAP_PG_READY_MS;
  process.env.COSTCAP_PG_READY_MS = "1";
  t.after(() => { if (prev === undefined) delete process.env.COSTCAP_PG_READY_MS; else process.env.COSTCAP_PG_READY_MS = prev; });
  await assert.rejects(startPostgres(t), /did not finish its restart/);
});

test("regression: stopping the test postgres removes its anonymous data volume", { skip: skipUnlessDocker() }, async (t) => {
  const { container, stop } = await startPostgres(t, { autoStop: false });
  t.after(stop);
  const volumes = spawnSync("docker", ["inspect", container, "--format", "{{range .Mounts}}{{if eq .Type \"volume\"}}{{.Name}} {{end}}{{end}}"], { encoding: "utf8" }).stdout.trim().split(/\s+/).filter(Boolean);
  assert.ok(volumes.length > 0, "postgres image should mount an anonymous data volume");
  stop();
  for (const v of volumes) {
    assert.notEqual(spawnSync("docker", ["volume", "inspect", v]).status, 0, `volume ${v} leaked after stop()`);
  }
});
