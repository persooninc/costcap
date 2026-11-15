// Release preflight for the npm package. Never publishes and never reads a token.
// Pure core (`checkRelease`) plus a CLI wrapper used by .github/workflows/release.yml:
//   node scripts/release-check.mjs [--ref refs/tags/v1.2.3]
// Prints `version=` and `dist_tag=` lines (for $GITHUB_OUTPUT) and exits 1 on any problem.
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?$/;
const REQUIRED = ["name", "version", "description", "license", "repository", "bin", "files", "engines"];

/**
 * @param {{ pkg: Record<string, any>, ref?: string, fileExists?: (path: string) => boolean, readText?: (path: string) => string }} input
 * @returns {{ ok: boolean, problems: string[], version: string, distTag: string }}
 */
export function checkRelease({ pkg, ref = "", fileExists = () => true, readText = () => "#!/usr/bin/env node" }) {
  const problems = [];
  for (const key of REQUIRED) if (pkg[key] === undefined || pkg[key] === "") problems.push(`package.json is missing "${key}"`);
  if (pkg.private) problems.push('package.json has "private": true');
  const version = String(pkg.version ?? "");
  const match = SEMVER.exec(version);
  if (!match) problems.push(`version "${version}" is not semver`);
  if (pkg.publishConfig?.access !== "public") problems.push('publishConfig.access must be "public"');
  const repo = typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url;
  if (repo && !/github\.com\/[^/]+\/[^/]+/.test(repo)) problems.push("repository must be a github.com URL (needed for provenance)");
  for (const [name, target] of Object.entries(pkg.bin ?? {})) {
    if (!fileExists(target)) problems.push(`bin "${name}" points at missing ${target}`);
    else if (!readText(target).startsWith("#!/usr/bin/env node")) problems.push(`bin "${name}" (${target}) has no node shebang`);
  }
  if (ref.startsWith("refs/tags/") && ref !== `refs/tags/v${version}`) {
    problems.push(`tag ${ref.slice("refs/tags/".length)} does not match package.json version v${version}`);
  } else if (ref && !ref.startsWith("refs/tags/") && !ref.startsWith("refs/heads/")) {
    problems.push(`unsupported ref ${ref}`);
  }
  const distTag = match?.[4] ? "next" : "latest";
  return { ok: problems.length === 0, problems, version, distTag };
}

const entry = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === entry) {
  const refIndex = process.argv.indexOf("--ref");
  const ref = refIndex > -1 ? process.argv[refIndex + 1] ?? "" : process.env.GITHUB_REF ?? "";
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  const result = checkRelease({ pkg, ref, fileExists: existsSync, readText: (path) => readFileSync(path, "utf8") });
  if (!result.ok) {
    for (const problem of result.problems) console.error(`release: ${problem}`);
    process.exit(1);
  }
  console.log(`version=${result.version}`);
  console.log(`dist_tag=${result.distTag}`);
  console.error(`release: ${pkg.name}@${result.version} is ready for dist-tag ${result.distTag}`);
}
