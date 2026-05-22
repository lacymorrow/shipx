import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

const CLI_PATH = resolve(import.meta.dir, "../../src/cli.ts");

function getHelpOutput(): string {
	return execFileSync("bun", ["run", CLI_PATH, "--help"], {
		encoding: "utf-8",
		stdio: "pipe",
	});
}

describe("help text", () => {
	test("--no-tests help text clarifies it overrides config (not a default-skip flag)", () => {
		const help = getHelpOutput();
		expect(help).not.toMatch(/--no-tests\s+Skip the test step/);
	});

	test("--no-cleanup help text clarifies it overrides config (not a default-skip flag)", () => {
		const help = getHelpOutput();
		expect(help).not.toMatch(/--no-cleanup\s+Skip the cleanup \(reinstall\) step/);
	});
});
