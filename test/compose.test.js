import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { applyDeploy } from "../scripts/deploy-apply.mjs";
import { skipUnlessDocker } from "./support/docker.js";

const skip = skipUnlessDocker(["compose", "version"]);
const repo = fileURLToPath(new URL("..", import.meta.url));
const required = ["COSTCAP_ORIGIN", "TURNSTILE_SITE_KEY", "TURNSTILE_SECRET_KEY", "BREVO_API_KEY", "COSTCAP_EMAIL_FROM"];

function env(values = {}) {
  const next = { ...process.env, COMPOSE_DISABLE_ENV_FILE: "1" };
  for (const key of required) delete next[key];
  return { ...next, ...values };
}

function compose(values) {
  return spawnSync("docker", ["compose", "config"], { cwd: repo, env: env(values), encoding: "utf8" });
}

test("compose config fails closed without required variables", { skip }, () => {
  const result = compose();
  assert.notEqual(result.status, 0);
  assert.match(`${result.stderr}`, /required variable (?:COSTCAP_ORIGIN|TURNSTILE_SITE_KEY|TURNSTILE_SECRET_KEY|BREVO_API_KEY|COSTCAP_EMAIL_FROM)/);
});

test("compose config renders one replica and a data volume for uid 1000", { skip }, () => {
  const marker = "not-a-real-mail-marker";
  const result = compose({
    COSTCAP_ORIGIN: "https://app.example.invalid",
    TURNSTILE_SITE_KEY: "public-placeholder",
    TURNSTILE_SECRET_KEY: "secret-placeholder",
    BREVO_API_KEY: marker,
    COSTCAP_EMAIL_FROM: "noreply@example.invalid",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /user: 1000:1000/);
  assert.match(result.stdout, /replicas: 1/);
  assert.match(result.stdout, /target: \/data/);
  assert.doesNotMatch(result.stdout, /replicas: [2-9]/);
  const serviceBlock = result.stdout.split(/^networks:/m)[0];
  assert.deepEqual(serviceBlock.match(/^  [a-z0-9-]+:$/gm), ["  costcap:"]);
});

test("deploy preflight reports missing names and does not print values", () => {
  const marker = "not-a-real-mail-marker";
  const missing = spawnSync(process.execPath, ["scripts/deploy-preflight.mjs"], { cwd: repo, env: env(), encoding: "utf8" });
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /COSTCAP_ORIGIN/);
  const ready = spawnSync(process.execPath, ["scripts/deploy-preflight.mjs"], {
    cwd: repo,
    env: env({
      COSTCAP_ORIGIN: "https://app.example.invalid",
      TURNSTILE_SITE_KEY: "public-placeholder",
      TURNSTILE_SECRET_KEY: marker,
      BREVO_API_KEY: marker,
      COSTCAP_EMAIL_FROM: "noreply@example.invalid",
    }),
    encoding: "utf8",
  });
  assert.equal(ready.status, 0, ready.stderr);
  assert.equal(ready.stderr.includes(marker), false);
  assert.match(ready.stderr, /apply was not run/);
  const apply = spawnSync(process.execPath, ["scripts/deploy-apply.mjs"], { cwd: repo, env: env({ COSTCAP_DEPLOY_HOST: "root@example" }), encoding: "utf8" });
  assert.equal(apply.status, 2);
  assert.match(apply.stderr, /apply was not run/);
  const workflow = readFileSync(new URL("../.github/workflows/deploy.yml", import.meta.url), "utf8");
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /deploy-preflight\.mjs/);
  assert.match(workflow, /deploy-apply\.mjs/);
  assert.match(workflow, /COSTCAP_DEPLOY_SSH_KEY/);
  assert.match(workflow, /COSTCAP_EXPECT_SHA/);
  assert.equal(workflow.includes("ssh "), false);
});

test("production compose is one replica on the existing data directory", { skip }, () => {
  const sha = "a".repeat(40);
  const result = spawnSync("docker", ["compose", "-f", "compose.production.yaml", "config"], {
    cwd: repo,
    env: env({
      COSTCAP_GIT_SHA: sha,
      COSTCAP_ORIGIN: "https://app.example.invalid",
      TURNSTILE_SITE_KEY: "public-placeholder",
      TURNSTILE_SECRET_KEY: "secret-placeholder",
      BREVO_API_KEY: "not-a-real-mail-marker",
      COSTCAP_EMAIL_FROM: "noreply@example.invalid",
    }),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /user: 1000:1000/);
  assert.match(result.stdout, /replicas: 1/);
  assert.match(result.stdout, /source: \/opt\/costcap\/data/);
  assert.match(result.stdout, /target: \/data/);
  assert.match(result.stdout, /app\.costcap\.dev/);
  assert.match(result.stdout, new RegExp(sha));
  assert.doesNotMatch(result.stdout, /replicas: [2-9]/);
  assert.equal((result.stderr || "").includes("not-a-real-mail-marker"), false);
});

test("apply contacts the host only when the key and commit are present", () => {
  const marker = "not-a-real-deploy-key";
  const calls = [];
  const dir = mkdtempSync(join(tmpdir(), "costcap-kh-"));
  const knownHostsPath = join(dir, "known_hosts");
  writeFileSync(knownHostsPath, "example ssh-ed25519 AAAApinned\n");
  let presented = "example ssh-ed25519 AAAApinned\n";
  const run = (file, args) => {
    calls.push([file, args]);
    return Buffer.from(file === "ssh-keyscan" ? presented : "");
  };
  const missing = applyDeploy({ host: "deploy@example", key: "", sha: "a".repeat(40), run, knownHostsPath });
  assert.equal(missing, 2);
  assert.equal(calls.length, 0);
  const sha = "b".repeat(40);
  const code = applyDeploy({ host: "deploy@example", key: marker, sha, cwd: repo, run, knownHostsPath });
  assert.equal(code, 0);
  assert.deepEqual(calls.map((call) => call[0]), ["ssh-keyscan", "tar", "ssh", "ssh"]);
  const flat = JSON.stringify(calls);
  assert.equal(flat.includes(marker), false);
  assert.match(flat, new RegExp(sha));
  assert.match(flat, /\/opt\/costcap\/src/);
  assert.match(flat, /deploy-remote\.sh/);
  // A changed host key stops before anything is sent.
  calls.length = 0;
  presented = "example ssh-ed25519 AAAArotated\n";
  assert.equal(applyDeploy({ host: "deploy@example", key: marker, sha, cwd: repo, run, knownHostsPath }), 3);
  assert.deepEqual(calls.map((call) => call[0]), ["ssh-keyscan"]);
  // The host preflight refusing the .env is exit 4, not a crash.
  presented = "example ssh-ed25519 AAAApinned\n";
  const refuse = (file, args) => {
    if (file === "ssh" && String(args.at(-1)).includes("deploy-remote.sh")) throw Object.assign(new Error("preflight"), { status: 2 });
    return run(file, args);
  };
  assert.equal(applyDeploy({ host: "deploy@example", key: marker, sha, cwd: repo, run: refuse, knownHostsPath }), 4);
  rmSync(dir, { recursive: true, force: true });
});
