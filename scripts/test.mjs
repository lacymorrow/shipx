#!/usr/bin/env node
/**
 * Runs every test file in its own bun process.
 *
 * `bun test src/` would be simpler, but `mock.module()` is global to the
 * process: the mocks in steps/homebrew.test.ts replace `exec` for every file
 * that runs alongside it, which makes steps/git.test.ts see a stubbed git and
 * report tags that do not exist. One process per file keeps the mocks where
 * their author intended them.
 */
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");

function findTests(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      out.push(...findTests(full));
    } else if (entry.name.endsWith(".test.ts")) {
      out.push(full);
    }
  }
  return out;
}

const files = findTests(join(root, "src")).sort();
if (files.length === 0) {
  console.error("No test files found under src/.");
  process.exit(1);
}

const failed = [];
for (const file of files) {
  const rel = relative(root, file);
  const result = spawnSync("bun", ["test", rel], { cwd: root, stdio: "inherit" });
  if (result.status !== 0) failed.push(rel);
}

console.log(`\n${files.length - failed.length}/${files.length} test files passed.`);
if (failed.length) {
  console.error(`Failed:\n${failed.map((f) => `  ${f}`).join("\n")}`);
  process.exit(1);
}
