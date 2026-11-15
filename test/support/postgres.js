// Disposable Postgres for tests (CI-only DB). Never touches a host Postgres.
import { spawnSync } from "node:child_process";
import { psql } from "../../scripts/db-migrate.mjs";

export async function startPostgres(t, { publish = false, autoStop = true } = {}) {
  const container = `cc-pg-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const args = ["run", "-d", "--rm", "--name", container, "-e", "POSTGRES_HOST_AUTH_METHOD=trust"];
  if (publish) args.push("-p", "127.0.0.1::5432");
  const started = spawnSync("docker", [...args, "postgres:16-alpine"], { encoding: "utf8" });
  if (started.status !== 0) throw new Error(started.stderr);
  // With autoStop: false the caller closes its clients first, then calls stop().
  const stop = () => spawnSync("docker", ["rm", "-f", container]);
  if (autoStop) t.after(stop);
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const logs = spawnSync("docker", ["logs", container], { encoding: "utf8" });
    const boots = `${logs.stdout}\n${logs.stderr}`.split("ready to accept connections").length - 1;
    if (boots >= 2) {
      try {
        if (psql(container, "SELECT 1;").trim() === "1") {
          let port = null;
          if (publish) port = Number(spawnSync("docker", ["port", container, "5432/tcp"], { encoding: "utf8" }).stdout.trim().split("\n")[0].split(":").pop());
          return { container, port, stop };
        }
      } catch { /* the final server is still opening its socket */ }
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("postgres did not finish its restart");
}
