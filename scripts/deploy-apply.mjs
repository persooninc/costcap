// Applies one replica when the deploy key, host, and commit are present. Otherwise it exits 2.
// Exit codes: 0 applied, 2 missing inputs, 3 host key does not match the pin (never connected),
// 4 the host preflight in deploy-remote.sh refused (running image unchanged), other = failure.
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const SHA_RE = /^[0-9a-f]{40}$/;
const HOST_RE = /^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+$/;

export const EXIT_APPLIED = 0;
export const EXIT_MISSING = 2;
export const EXIT_HOST_KEY = 3;
export const EXIT_HOST_PREFLIGHT = 4;

// Parses known_hosts text into Map<type, Set<base64>> for one plain (unhashed) host name.
export function keysForHost(text, hostname) {
  const keys = new Map();
  for (const raw of String(text || "").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const [names, type, key] = line.split(/\s+/);
    if (!names || !type || !key) continue;
    if (!names.split(",").includes(hostname)) continue;
    if (!keys.has(type)) keys.set(type, new Set());
    keys.get(type).add(key);
  }
  return keys;
}

// Compares what the host presents (ssh-keyscan output) with the pinned keys.
// ok when at least one presented key is pinned and no presented type contradicts its pin.
// reachable is false when the scan returned nothing; ssh then reports the network error itself.
export function compareHostKeys({ pinned, scanned, hostname }) {
  const pin = keysForHost(pinned, hostname);
  const seen = keysForHost(scanned, hostname);
  if (seen.size === 0) return { ok: true, reachable: false, mismatched: [] };
  let matched = false;
  const mismatched = [];
  for (const [type, presented] of seen) {
    const expected = pin.get(type);
    if (!expected) continue;
    for (const key of presented) {
      if (expected.has(key)) matched = true;
      else mismatched.push(type);
    }
  }
  return { ok: matched && mismatched.length === 0, reachable: true, mismatched: [...new Set(mismatched)] };
}

export function applyDeploy({ host = "", key = "", sha = "", cwd = process.cwd(), run = execFileSync, knownHostsPath } = {}) {
  if (!host || !key || !SHA_RE.test(sha)) {
    console.error("deploy: apply was not run; COSTCAP_DEPLOY_HOST, COSTCAP_DEPLOY_SSH_KEY, or COSTCAP_GIT_SHA is missing");
    return EXIT_MISSING;
  }
  if (!HOST_RE.test(host)) {
    console.error("deploy: apply was not run; COSTCAP_DEPLOY_HOST is not a user@host");
    return EXIT_MISSING;
  }
  const knownHosts = knownHostsPath || resolve(cwd, "infra/ssh/costcap-deploy.known_hosts");
  const pinned = existsSync(knownHosts);
  if (pinned) {
    const hostname = host.split("@")[1];
    let scanned = "";
    try {
      scanned = String(run("ssh-keyscan", ["-T", "10", "-t", "ed25519,ecdsa,rsa", hostname], { stdio: ["ignore", "pipe", "ignore"] }) || "");
    } catch (error) {
      scanned = String(error?.stdout || "");
    }
    const check = compareHostKeys({ pinned: readFileSync(knownHosts, "utf8"), scanned, hostname });
    if (!check.ok) {
      const which = check.mismatched.length ? check.mismatched.join(", ") : "no pinned key type";
      console.error(`deploy: apply was not run; the deploy host's SSH key does not match infra/ssh/costcap-deploy.known_hosts (${which}). Verify the new key out of band before updating the pin.`);
      return EXIT_HOST_KEY;
    }
  }
  const dir = mkdtempSync(join(tmpdir(), "costcap-deploy-"));
  const keyPath = join(dir, "id");
  try {
    writeFileSync(keyPath, key.endsWith("\n") ? key : `${key}\n`, { mode: 0o600 });
    chmodSync(keyPath, 0o600);
    const ssh = ["-i", keyPath, "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes", "-o", "ConnectTimeout=20"];
    if (pinned) ssh.push("-o", `UserKnownHostsFile=${knownHosts}`, "-o", "StrictHostKeyChecking=yes");
    const archive = run("tar", ["-czf", "-", "--exclude", "node_modules", "--exclude", ".git", "--exclude", ".env", "-C", cwd, "."], { maxBuffer: 64 * 1024 * 1024 });
    run("ssh", [...ssh, host, "rm -rf /opt/costcap/src && mkdir -p /opt/costcap/src && tar -xzf - -C /opt/costcap/src"], { input: archive });
    try {
      run("ssh", [...ssh, host, `sh /opt/costcap/src/scripts/deploy-remote.sh ${sha}`]);
    } catch (error) {
      // deploy-remote.sh exits 2 when the host .env fails its preflight, before anything is built.
      if (error?.status === 2) {
        console.error("deploy: the host preflight refused this deploy (see deploy-remote.sh output above); the running image is unchanged");
        return EXIT_HOST_PREFLIGHT;
      }
      throw error;
    }
    console.error("deploy: apply finished");
    return EXIT_APPLIED;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exit(applyDeploy({
    host: process.env.COSTCAP_DEPLOY_HOST || "",
    key: process.env.COSTCAP_DEPLOY_SSH_KEY || "",
    sha: process.env.COSTCAP_GIT_SHA || "",
  }));
}
