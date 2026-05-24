import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { loadConfig, normalizeFlags } from "./config.ts";

describe("normalizeFlags (M2)", () => {
	test("undefined → empty array", () => {
		expect(normalizeFlags(undefined)).toEqual([]);
	});

	test("passes through an array unchanged", () => {
		expect(normalizeFlags(["--no-verify"])).toEqual(["--no-verify"]);
		expect(normalizeFlags(["--force-with-lease", "--no-verify"])).toEqual([
			"--force-with-lease",
			"--no-verify",
		]);
	});

	test("preserves array entries containing spaces verbatim", () => {
		// This is exactly what whitespace-splitting a string breaks.
		expect(normalizeFlags(["-m", "release: v1"])).toEqual(["-m", "release: v1"]);
	});

	test("strings split on whitespace (backward compat with old config form)", () => {
		expect(normalizeFlags("--no-verify")).toEqual(["--no-verify"]);
		expect(normalizeFlags("--force-with-lease --no-verify")).toEqual([
			"--force-with-lease",
			"--no-verify",
		]);
	});

	test("string form drops empty tokens from extra whitespace", () => {
		expect(normalizeFlags("  --no-verify   --no-gpg-sign  ")).toEqual([
			"--no-verify",
			"--no-gpg-sign",
		]);
	});

	test("array form drops empty-string entries", () => {
		expect(normalizeFlags(["", "--no-verify", ""])).toEqual(["--no-verify"]);
	});
});

describe("loadConfig npm.cwd auto-detection", () => {
	let root: string;

	beforeEach(() => {
		root = mkdtempSync(resolve(tmpdir(), "shipx-cfg-"));
		// Mark as a git repo so any downstream consumers behave; not strictly
		// required for loadConfig but keeps it close to real-world use.
		execSync("git init -q", { cwd: root });
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	function writePkg(dir: string, pkg: object): void {
		mkdirSync(dir, { recursive: true });
		writeFileSync(resolve(dir, "package.json"), JSON.stringify(pkg));
	}

	test("publishable root: npm.cwd defaults to root, no auto-detect reason", async () => {
		writePkg(root, { name: "foo", bin: "cli.js" });
		const cfg = await loadConfig(root);
		expect(cfg.npm.cwd).toBe(root);
		expect(cfg.npm.autoDetectedReason).toBe("");
	});

	test('"private": true root: auto-detects single publishable subpackage', async () => {
		writePkg(root, { name: "lacy", private: true });
		writePkg(resolve(root, "packages/lacy"), { name: "lacy", bin: { lacy: "index.mjs" } });

		const cfg = await loadConfig(root);
		expect(cfg.npm.cwd).toBe(resolve(root, "packages/lacy"));
		expect(cfg.npm.autoDetectedReason).toMatch(/packages\/lacy/);
		expect(cfg.npm.targets[0].cwd).toBe(resolve(root, "packages/lacy"));
	});

	test("auto-detection also points packageJsonPaths + versionSource at the detected subpackage", async () => {
		writePkg(root, { name: "lacy", private: true });
		writePkg(resolve(root, "packages/lacy"), { name: "lacy", bin: "x.js" });

		const cfg = await loadConfig(root);
		expect(cfg.versionSource).toBe("packages/lacy/package.json");
		// Subpackage first so preflight (which reads paths[0]) sees the right
		// bin/files; root second so it still gets a version bump in lockstep.
		expect(cfg.packageJsonPaths).toEqual([
			"packages/lacy/package.json",
			"package.json",
		]);
	});

	test("user-set packageJsonPaths is not overridden by auto-detection", async () => {
		writePkg(root, { name: "lacy", private: true });
		writePkg(resolve(root, "packages/lacy"), { name: "lacy", bin: "x.js" });
		writeFileSync(
			resolve(root, ".shipxrc.json"),
			JSON.stringify({ packageJsonPaths: ["custom.json"] }),
		);

		const cfg = await loadConfig(root);
		expect(cfg.packageJsonPaths).toEqual(["custom.json"]);
		// npm.cwd still auto-detects independently
		expect(cfg.npm.cwd).toBe(resolve(root, "packages/lacy"));
	});

	test("ambiguous root: falls back to root and records the ambiguity", async () => {
		writePkg(root, { name: "monorepo", private: true });
		writePkg(resolve(root, "packages/a"), { name: "a", main: "a.js" });
		writePkg(resolve(root, "packages/b"), { name: "b", main: "b.js" });

		const cfg = await loadConfig(root);
		expect(cfg.npm.cwd).toBe(root);
		expect(cfg.npm.autoDetectedReason).toMatch(/set npm.cwd or npm.targets explicitly/);
	});

	test("user-set npm.cwd overrides detection and is resolved against root", async () => {
		writePkg(root, { name: "lacy", private: true });
		writePkg(resolve(root, "packages/lacy"), { name: "lacy", bin: "x.js" });
		writePkg(resolve(root, "packages/other"), { name: "other", bin: "y.js" });
		writeFileSync(
			resolve(root, ".shipxrc.json"),
			JSON.stringify({ npm: { cwd: "packages/other" } }),
		);

		const cfg = await loadConfig(root);
		expect(cfg.npm.cwd).toBe(resolve(root, "packages/other"));
		expect(cfg.npm.autoDetectedReason).toBe("");
	});
});
