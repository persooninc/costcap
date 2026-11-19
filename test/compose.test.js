import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { applyDeploy, EXIT_AUTH, isAuthRejected } from "../scripts/deploy-apply.mjs";
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
  assert.deepEqual(calls.map((call) => call[0]), ["ssh-keyscan", "ssh", "tar", "ssh", "ssh"]);
  assert.equal(calls[1][1].at(-1), "true", "auth probe runs before the tree is sent");
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

test("a deploy key the host rejects is exit 5 and nothing is sent", () => {
  const dir = mkdtempSync(join(tmpdir(), "costcap-kh-"));
  const knownHostsPath = join(dir, "known_hosts");
  writeFileSync(knownHostsPath, "example ssh-ed25519 AAAApinned\n");
  const calls = [];
  const denied = Object.assign(new Error("ssh failed"), { status: 255, stderr: Buffer.from("deploy@example: Permission denied (publickey).\r\n") });
  const run = (file, args) => {
    calls.push(file);
    if (file === "ssh-keyscan") return Buffer.from("example ssh-ed25519 AAAApinned\n");
    if (file === "ssh") throw denied;
    return Buffer.from("");
  };
  const errors = [];
  const original = process.stderr.write;
  process.stderr.write = (chunk) => { errors.push(String(chunk)); return true; };
  let code;
  try {
    code = applyDeploy({ host: "deploy@example", key: "not-a-real-deploy-key", sha: "c".repeat(40), cwd: repo, run, knownHostsPath });
  } finally {
    process.stderr.write = original;
  }
  assert.equal(code, EXIT_AUTH);
  assert.equal(code, 5);
  assert.deepEqual(calls, ["ssh-keyscan", "ssh"], "no tar upload and no deploy-remote.sh after a rejected key");
  assert.match(errors.join(""), /Permission denied \(publickey\)/);
  assert.equal(errors.join("").includes("not-a-real-deploy-key"), false);
  // A network failure on the probe is not an owner-blocked skip: it still throws.
  const unreachable = Object.assign(new Error("ssh failed"), { status: 255, stderr: Buffer.from("ssh: connect to host example port 22: Connection timed out\r\n") });
  const offline = (file) => {
    if (file === "ssh-keyscan") return Buffer.from("example ssh-ed25519 AAAApinned\n");
    if (file === "ssh") throw unreachable;
    return Buffer.from("");
  };
  process.stderr.write = () => true;
  try {
    assert.throws(() => applyDeploy({ host: "deploy@example", key: "k", sha: "c".repeat(40), cwd: repo, run: offline, knownHostsPath }), /ssh failed/);
  } finally {
    process.stderr.write = original;
  }
  rmSync(dir, { recursive: true, force: true });
});

test("isAuthRejected matches only ssh's Permission denied exit", () => {
  assert.equal(isAuthRejected({ status: 255, stderr: "u@h: Permission denied (publickey,password)." }), true);
  assert.equal(isAuthRejected({ status: 255, stderr: "Connection refused" }), false);
  assert.equal(isAuthRejected({ status: 1, stderr: "Permission denied (publickey)." }), false);
  assert.equal(isAuthRejected(undefined), false);
});

test("auto-deploy warns and skips on exits 3, 4 and 5; manual dispatch and other codes fail", () => {
  const workflow = readFileSync(join(repo, ".github/workflows/deploy.yml"), "utf8");
  const step = workflow.slice(workflow.indexOf("- name: apply one replica"), workflow.indexOf("- name: canary the applied origin"));
  const lines = step.split("\n");
  const start = lines.findIndex((line) => /^\s+run: \|$/.test(line));
  assert.ok(start > 0, "apply step has a run block");
  const indent = lines[start + 1].match(/^\s*/)[0].length;
  const script = lines.slice(start + 1).filter((line) => line.trim()).map((line) => line.slice(indent)).join("\n");
  assert.match(script, /node scripts\/deploy-apply\.mjs/);
  const dir = mkdtempSync(join(tmpdir(), "costcap-apply-step-"));
  const runStep = (event, code) => {
    const out = join(dir, `out-${event}-${code}`);
    const summary = join(dir, `summary-${event}-${code}`);
    writeFileSync(out, "");
    writeFileSync(summary, "");
    const body = script.replace("node scripts/deploy-apply.mjs", `(exit ${code})`);
    const result = spawnSync("bash", ["-e", "-c", body], {
      env: { PATH: process.env.PATH, EVENT: event, DEPLOY_SHA: "d".repeat(40), GITHUB_OUTPUT: out, GITHUB_STEP_SUMMARY: summary },
      encoding: "utf8",
    });
    return { status: result.status, stdout: result.stdout, output: readFileSync(out, "utf8"), summary: readFileSync(summary, "utf8") };
  };
  assert.equal(runStep("workflow_run", 0).output.trim(), "applied=true");
  for (const [code, reason] of [[3, /known_hosts/], [4, /host \.env/], [5, /rejected the deploy key/]]) {
    const skipped = runStep("workflow_run", code);
    assert.equal(skipped.status, 0, `auto run skips exit ${code}`);
    assert.equal(skipped.output.trim(), "applied=false");
    assert.match(skipped.stdout, /::warning title=auto-deploy skipped::/);
    assert.match(skipped.stdout, reason);
    assert.match(skipped.summary, /Production is unchanged/);
    assert.equal(runStep("workflow_dispatch", code).status, code, `manual dispatch fails on exit ${code}`);
  }
  assert.equal(runStep("workflow_run", 1).status, 1, "an unexpected failure still fails the auto run");
  rmSync(dir, { recursive: true, force: true });
});

test("apex costcap.dev serves /pricing directly instead of redirecting (costcap#141)", () => {
  const text = readFileSync(join(repo, "compose.production.yaml"), "utf8");
  const label = (k) => text.match(new RegExp(`traefik\\.http\\.routers\\.cc-apex-pricing\\.${k.replace(/\./g, "\\.")}=(.*)`))?.[1]?.trim();
  assert.match(label("rule"), /Host\(`costcap\.dev`\)/);
  assert.match(label("rule"), /Path\(`\/pricing`\)/);
  assert.equal(label("service"), "cc");
  assert.equal(label("entryPoints"), "https");
  assert.ok(Number(label("priority")) > 100, "must outrank the apex redirect router");
  assert.doesNotMatch(label("middlewares"), /cc-apex/);
});

test("apex costcap.dev serves the marketing root and discovery files directly (go-to-market#18)", () => {
  const text = readFileSync(join(repo, "compose.production.yaml"), "utf8");
  const label = (k) => text.match(new RegExp(`traefik\\.http\\.routers\\.cc-apex-site\\.${k.replace(/\./g, "\\.")}=(.*)`))?.[1]?.trim();
  assert.match(label("rule"), /Host\(`costcap\.dev`\)/);
  for (const p of ["/", "/og.png", "/llms.txt", "/robots.txt", "/sitemap.xml"]) assert.ok(label("rule").includes("Path(`" + p + "`)"), p);
  assert.equal(label("service"), "cc");
  assert.ok(Number(label("priority")) > 100);
  assert.doesNotMatch(label("middlewares"), /cc-apex/);
});
