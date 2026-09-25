import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResolvedConfig } from "../types.ts";

mock.module("@clack/prompts", () => ({
	spinner: () => ({ start: () => {}, stop: () => {} }),
	log: { warn: () => {}, info: () => {}, error: () => {}, message: () => {} },
}));

const { bumpCargoWorkspaces } = await import("./cargo.ts");

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf-8" });
}

/**
 * Lay out a repo like a typical Tauri project: the Cargo workspace is rooted
 * at the repo root and `src-tauri` is just one member, alongside a member
 * that lives outside the configured cargoWorkspaces dir.
 */
function makeWorkspaceRepo(root: string): void {
	writeFileSync(
		join(root, "Cargo.toml"),
		'[workspace]\nresolver = "2"\nmembers = ["src-tauri", "crates/other"]\n\n[workspace.package]\nversion = "1.0.0"\n',
	);
	writeFileSync(
		join(root, "Cargo.lock"),
		'[[package]]\nname = "app"\nversion = "1.0.0"\n\n[[package]]\nname = "other"\nversion = "1.0.0"\n',
	);
	mkdirSync(join(root, "src-tauri"), { recursive: true });
	writeFileSync(
		join(root, "src-tauri", "Cargo.toml"),
		'[package]\nname = "app"\nversion = "1.0.0"\n',
	);
	mkdirSync(join(root, "crates", "other"), { recursive: true });
	writeFileSync(
		join(root, "crates", "other", "Cargo.toml"),
		'[package]\nname = "other"\nversion = "1.0.0"\n',
	);
	writeFileSync(join(root, "README.md"), "readme\n");

	git(root, "init", "-q");
	git(root, "config", "user.email", "test@example.com");
	git(root, "config", "user.name", "test");
	git(root, "add", "-A");
	git(root, "commit", "-q", "-m", "init");
}

/**
 * Fake `cargo` binary that mimics `cargo set-version --workspace <v>`:
 * regardless of the cwd it runs in, it resolves upward to the workspace
 * root and rewrites every member manifest plus the lockfile.
 */
function installFakeCargo(binDir: string, repoRoot: string): void {
	const script = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const version = process.argv[process.argv.length - 1];
const root = ${JSON.stringify(repoRoot)};
for (const rel of ["Cargo.toml", "src-tauri/Cargo.toml", "crates/other/Cargo.toml"]) {
	const file = path.join(root, rel);
	const next = fs.readFileSync(file, "utf-8").replace(/version = "[^"]+"/, 'version = "' + version + '"');
	fs.writeFileSync(file, next);
}
const lock = path.join(root, "Cargo.lock");
fs.writeFileSync(lock, fs.readFileSync(lock, "utf-8").replace(/version = "[^"]+"/g, 'version = "' + version + '"'));
`;
	const cargoPath = join(binDir, "cargo");
	writeFileSync(cargoPath, script);
	chmodSync(cargoPath, 0o755);
}

function makeConfig(root: string): ResolvedConfig {
	const partial: Partial<ResolvedConfig> = {
		root,
		cargoWorkspaces: ["src-tauri"],
	};
	return partial as ResolvedConfig;
}

describe("bumpCargoWorkspaces", () => {
	let root: string;
	let binDir: string;
	const originalPath = process.env.PATH;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "shipx-cargo-test-"));
		binDir = mkdtempSync(join(tmpdir(), "shipx-cargo-bin-"));
		makeWorkspaceRepo(root);
		installFakeCargo(binDir, root);
		process.env.PATH = `${binDir}:${originalPath}`;
	});

	afterEach(() => {
		process.env.PATH = originalPath;
		rmSync(root, { recursive: true, force: true });
		rmSync(binDir, { recursive: true, force: true });
	});

	test("stages every Cargo file the bump rewrote, including members outside the workspace dir", async () => {
		const staged = await bumpCargoWorkspaces(makeConfig(root), "1.1.0");

		expect(staged.sort()).toEqual([
			"Cargo.lock",
			"Cargo.toml",
			"crates/other/Cargo.toml",
			"src-tauri/Cargo.toml",
		]);
	});

	test("staged paths produce a release commit containing all bumped members", async () => {
		const staged = await bumpCargoWorkspaces(makeConfig(root), "1.1.0");

		git(root, "add", ...staged);
		git(root, "commit", "-q", "-m", "release: v1.1.0");

		const committed = git(root, "show", "--name-only", "--format=", "HEAD")
			.trim()
			.split("\n")
			.sort();
		expect(committed).toEqual([
			"Cargo.lock",
			"Cargo.toml",
			"crates/other/Cargo.toml",
			"src-tauri/Cargo.toml",
		]);

		const tagged = git(root, "show", "HEAD:crates/other/Cargo.toml");
		expect(tagged).toContain('version = "1.1.0"');
	});

	test("does not stage unrelated dirty files", async () => {
		writeFileSync(join(root, "README.md"), "dirty edit\n");

		const staged = await bumpCargoWorkspaces(makeConfig(root), "1.1.0");

		expect(staged).not.toContain("README.md");
	});

	test("returns nothing when no cargo workspaces are configured", async () => {
		const config = { root, cargoWorkspaces: [] } as Partial<ResolvedConfig> as ResolvedConfig;
		expect(await bumpCargoWorkspaces(config, "1.1.0")).toEqual([]);
	});
});
