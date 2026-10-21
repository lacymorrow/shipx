/**
 * End-to-end regression tests for unattended `--multi` (#70, #74).
 *
 * These spawn the real CLI, because the bug was that batch mode opened a
 * prompt with nobody there to answer it: a unit test on any one function
 * cannot see a stall that only exists once the whole pipeline runs. Each case
 * asserts both halves — the run reached a verdict, *and* no prompt was printed
 * on the way there.
 *
 * Everything here is offline. The fixtures have no git remote (so the archived
 * check makes no API call) and either declare `private` or get a stub `npm` on
 * PATH.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const CLI = resolve(import.meta.dir, "cli.ts");

/** Generous: each case spawns bun, which loads and runs the whole CLI. */
const SPAWN_TIMEOUT_MS = 60_000;

function git(cwd: string, ...args: string[]): string {
	const result = spawnSync("git", args, { cwd, encoding: "utf-8" });
	if (result.status !== 0) {
		throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
	}
	return result.stdout.trim();
}

/**
 * A git repo with one commit, built with plumbing rather than `git commit`.
 *
 * `commit-tree` takes the same identity from the repo's own config but runs no
 * hooks, so the fixture does not depend on (or trip over) whatever pre-commit
 * hooks the machine running the tests has installed globally.
 */
function makeRepo(parent: string, dirName: string, files: Record<string, object>): string {
	const root = resolve(parent, dirName);
	mkdirSync(root, { recursive: true });
	for (const [name, content] of Object.entries(files)) {
		writeFileSync(resolve(root, name), `${JSON.stringify(content, null, 2)}\n`);
	}

	git(root, "init", "-q", "-b", "main");
	git(root, "config", "user.email", "shipx-test@example.invalid");
	git(root, "config", "user.name", "shipx test");
	git(root, "add", "-A");
	const tree = git(root, "write-tree");
	const commit = git(root, "commit-tree", tree, "-m", "init");
	git(root, "update-ref", "refs/heads/main", commit);
	return root;
}

function makeParentDir(): string {
	return mkdtempSync(resolve(tmpdir(), "shipx-multi-e2e-"));
}

interface RunResult {
	status: number | null;
	signal: string | null;
	output: string;
}

/**
 * Run the CLI in `cwd` with stdin at /dev/null.
 *
 * `fakeTty` reports stdin as a terminal before the CLI loads. That is the only
 * way to tell the two halves of the bug apart: with a pipe or /dev/null,
 * `isNonInteractive()` is already true from the non-TTY check, so a run would
 * take the unattended path even if `--yes` were still being dropped. Faking a
 * TTY leaves `--yes` as the only thing that can answer the prompts.
 */
function runCli(
	args: string[],
	opts: { cwd: string; fakeTty?: boolean; path?: string },
): RunResult {
	let entry = CLI;
	if (opts.fakeTty) {
		entry = resolve(opts.cwd, "tty-harness.mjs");
		writeFileSync(
			entry,
			'Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });\n' +
			'Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });\n' +
			`await import(${JSON.stringify(CLI)});\n`,
		);
	}

	const env: Record<string, string> = { ...process.env } as Record<string, string>;
	// Leave `CI` and `SHIPX_ROOT` out of it: the point is what the flags and
	// the terminal say, not what the machine running the tests happens to export.
	delete env.CI;
	delete env.SHIPX_ROOT;
	delete env.FORCE_COLOR;
	env.NO_COLOR = "1";
	if (opts.path) env.PATH = `${opts.path}:${env.PATH}`;

	const result = spawnSync("bun", [entry, ...args], {
		cwd: opts.cwd,
		stdio: ["ignore", "pipe", "pipe"],
		encoding: "utf-8",
		timeout: SPAWN_TIMEOUT_MS,
		env,
	});

	// Strip ANSI so assertions match on the words, not on whatever colour
	// support the terminal running the tests happens to advertise.
	const raw = `${result.stdout ?? ""}${result.stderr ?? ""}`;
	return {
		status: result.status,
		signal: result.signal,
		output: stripAnsi(raw),
	};
}

/** ESC-prefixed CSI sequences, written without a literal escape character. */
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, "g");

function stripAnsi(text: string): string {
	return text.replace(ANSI, "");
}

/** The prompts an unattended batch must never open. */
const PROMPTS = [
	"Select projects to release",
	"Version bump strategy",
	"npm authentication method",
	"Beta bump?",
];

function expectNoPrompts(output: string): void {
	for (const prompt of PROMPTS) {
		expect(output).not.toContain(prompt);
	}
}

describe("shipx --multi, unattended (#70)", () => {
	test(
		"--multi <bump> --yes releases the pre-selected projects with stdin closed",
		() => {
			const parent = makeParentDir();
			makeRepo(parent, "proj-a", {
				"package.json": { name: "proj-a", version: "1.0.0", private: true },
			});
			makeRepo(parent, "proj-b", {
				"package.json": { name: "proj-b", version: "2.3.4", private: true },
			});

			const result = runCli(["--multi", "patch", "--dry-run", "--yes"], { cwd: parent });

			expect(result.signal).toBeNull();
			expect(result.status).toBe(0);
			expectNoPrompts(result.output);
			// Both projects, each bumped by the level named on the command line.
			expect(result.output).toContain("proj-a");
			expect(result.output).toContain("v1.0.1");
			expect(result.output).toContain("proj-b");
			expect(result.output).toContain("v2.3.5");
		},
		SPAWN_TIMEOUT_MS,
	);

	// This is the half a closed stdin cannot prove. At a terminal, `--yes` is
	// the only thing that makes the run unattended — and `setAssumeYes` used to
	// be called *after* the `--multi` hand-off, so batch mode never saw it.
	test(
		"--multi <bump> --yes answers its own prompts at a terminal",
		() => {
			const parent = makeParentDir();
			makeRepo(parent, "proj-a", {
				"package.json": { name: "proj-a", version: "1.0.0", private: true },
			});

			const result = runCli(["--multi", "patch", "--dry-run", "--yes"], {
				cwd: parent,
				fakeTty: true,
			});

			expect(result.signal).toBeNull();
			expect(result.status).toBe(0);
			expectNoPrompts(result.output);
			expect(result.output).toContain("v1.0.1");
		},
		SPAWN_TIMEOUT_MS,
	);

	// `--beta` is documented for batch mode, and a project already on a beta
	// reaches a select that a named level does not answer.
	test(
		"--multi <bump> --beta --yes bumps an in-flight beta without prompting",
		() => {
			const parent = makeParentDir();
			makeRepo(parent, "proj-a", {
				"package.json": { name: "proj-a", version: "1.0.0-beta.3", private: true },
			});

			const result = runCli(["--multi", "patch", "--beta", "--dry-run", "--yes"], { cwd: parent });

			expect(result.signal).toBeNull();
			expect(result.status).toBe(0);
			expectNoPrompts(result.output);
			expect(result.output).toContain("v1.0.0-beta.4");
		},
		SPAWN_TIMEOUT_MS,
	);

	test(
		"--multi --yes with no bump level says what is missing and exits 1",
		() => {
			const parent = makeParentDir();
			makeRepo(parent, "proj-a", {
				"package.json": { name: "proj-a", version: "1.0.0", private: true },
			});

			const result = runCli(["--multi", "--dry-run", "--yes"], { cwd: parent });

			expect(result.signal).toBeNull();
			expect(result.status).toBe(1);
			expectNoPrompts(result.output);
			expect(result.output).toContain("shipx --multi patch --yes");
		},
		SPAWN_TIMEOUT_MS,
	);

	test(
		"--multi --yes over a directory with nothing to release exits 0",
		() => {
			// A scheduled batch release should not fail just because no project
			// has unreleased work. Tagging the only commit leaves nothing after
			// the last tag, so nothing is pre-selected.
			const parent = makeParentDir();
			const root = makeRepo(parent, "proj-a", {
				"package.json": { name: "proj-a", version: "1.0.0", private: true },
			});
			git(root, "tag", "v1.0.0");

			const result = runCli(["--multi", "patch", "--dry-run", "--yes"], { cwd: parent });

			expect(result.signal).toBeNull();
			expect(result.status).toBe(0);
			expectNoPrompts(result.output);
			expect(result.output).toContain("Nothing to do");
		},
		SPAWN_TIMEOUT_MS,
	);

	test(
		"--multi --yes skips a project on the wrong branch instead of asking",
		() => {
			const parent = makeParentDir();
			const root = makeRepo(parent, "proj-a", {
				"package.json": { name: "proj-a", version: "1.0.0", private: true },
			});
			git(root, "checkout", "-q", "-b", "feature/wip");

			const result = runCli(["--multi", "patch", "--dry-run", "--yes"], { cwd: parent });

			expect(result.signal).toBeNull();
			// A skip, not a failure: `--any-branch` is the documented way to say
			// yes to this up front, and failing the batch because one repo in the
			// directory sits on a feature branch would make unattended mode
			// unusable in a working directory.
			expect(result.status).toBe(0);
			expectNoPrompts(result.output);
			expect(result.output).not.toContain("Switch to main");
			expect(result.output).toContain("--any-branch");
		},
		SPAWN_TIMEOUT_MS,
	);
});

describe("shipx --multi, failed publishes (#74)", () => {
	/**
	 * A stub `npm` placed first on PATH: authenticated, but every publish is
	 * rejected. Stands in for an expired token, which is the case that used to
	 * exit 0 with a ✓ per project.
	 */
	function makeFailingNpm(dir: string): string {
		mkdirSync(dir, { recursive: true });
		const npm = resolve(dir, "npm");
		writeFileSync(
			npm,
			[
				"#!/bin/sh",
				'case "$1" in',
				"  whoami) echo stub-user; exit 0 ;;",
				'  view) echo "npm error code E404" >&2; exit 1 ;;',
				'  publish) echo "npm error code E403 Forbidden - stub rejects every publish" >&2; exit 1 ;;',
				"esac",
				"exit 0",
				"",
			].join("\n"),
		);
		chmodSync(npm, 0o755);
		return dir;
	}

	/** Every git-touching step off, so the test exercises phase 2 and nothing else. */
	const PUBLISH_ONLY_CONFIG = {
		steps: {
			preflight: false,
			changelog: false,
			bumpVersion: false,
			commit: false,
			tag: false,
			push: false,
			githubRelease: false,
			homebrew: false,
			watchCi: false,
			npm: true,
		},
	};

	test(
		"an unattended batch whose publishes are rejected exits non-zero and names them",
		() => {
			const parent = makeParentDir();
			makeRepo(parent, "proj-a", {
				"package.json": { name: "proj-a", version: "1.0.0", bin: "cli.js" },
				".shipxrc.json": PUBLISH_ONLY_CONFIG,
			});

			const result = runCli(["--multi", "patch", "--yes"], {
				cwd: parent,
				path: makeFailingNpm(resolve(parent, "stub-bin")),
			});

			expect(result.signal).toBeNull();
			expect(result.status).toBe(1);
			// Phase 2 runs after every tag is pushed, so a prompt here would
			// leave the whole batch half-shipped.
			expectNoPrompts(result.output);
			expect(result.output).toContain("npm publish");
			expect(result.output).toContain("proj-a");
		},
		SPAWN_TIMEOUT_MS,
	);
});
