// Docker-backed tests skip on hosts without Docker, but never in CI: a skip
// there would turn a broken runner into a green build.
import { spawnSync } from "node:child_process";

export function skipUnlessDocker(args = ["info"]) {
  if (process.env.CI) return false;
  return spawnSync("docker", args, { stdio: "ignore" }).status === 0 ? false : "Docker is not available on this host";
}
