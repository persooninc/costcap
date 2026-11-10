import { test } from "node:test";
import { strict as assert } from "node:assert";
import { VERSION } from "../src/version.js";
import { readFileSync } from "node:fs";

test("VERSION matches package.json version", () => {
  const packageJson = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8")
  );
  
  assert.equal(VERSION, packageJson.version);
});
