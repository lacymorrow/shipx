import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * A release where `npm publish` failed is a half-shipped release, and the only
 * thing an unattended caller reads is the exit code. These run the real CLI
 * against a throwaway project with a fake `npm` on PATH, because the bug was
 * never in one function: the publish failed, the retry menu opened with nobody
 * to answer it, the awaited prompt never settled, and the process left with
 * code 0 (lacymorrow/shipx#69).
 */

const CLI_PATH = resolve(import.meta.dir, "../../src/cli.ts");
const FIXTURE_PKG_NAME = "shipx-exit-code-fixture";

let workdir: string;
let projectDir: string;
let fakeBinDir: string;
let baseSha: string;

/**
 * `npm` stand-in. `publish` is the knob each test sets; the other subcommands
 * answer the way a logged-in machine would, so the run reaches the publish step
 * without touching the network.
 *
 * The two `view` calls need different answers: the pre-release registry check
 * asks for a bare version and has to miss, or shipx bumps from the registry
 * instead of the local 1.0.0, while the post-publish check asks for `--json`
 * and has to hit, or it retries for three minutes waiting out CDN lag.
 */
function writeFakeNpm(publishExitCode: number): void {
	writeFileSync(
		join(fakeBinDir, "npm"),
		`#!/bin/sh
case "$1" in
  whoami) echo "fake-user"; exit 0 ;;
  config) echo "https://registry.npmjs.org/"; exit 0 ;;
  view)
    case "$*" in
      *--json*) echo '{"name":"${FIXTURE_PKG_NAME}","main":"index.js"}'; exit 0 ;;
    esac
    echo "npm error code E404" >&2; exit 1 ;;
  publish) echo "npm error code EPUBLISHCONFLICT" >&2; exit ${publishExitCode} ;;
esac
exit 0
`,
	);
	chmodSync(join(fakeBinDir, "npm"), 0o755);
}

function git(...args: string[]): string {
	return execFileSync("git", args, { cwd: projectDir, encoding: "utf-8", stdio: "pipe" });
}

/** clack colours its output even through a pipe, so assertions read the plain text. */
function stripAnsi(text: string): string {
	return text.replace(/\u001b\[[0-9;?]*[a-zA-Z]/g, "");
}

/** One release attempt, with nothing on stdin and `CI` set, the way a workflow runs it. */
function runRelease(): { status: number | null; output: string } {
	const result = spawnSync("bun", ["run", CLI_PATH, "patch", "--yes"], {
		cwd: projectDir,
		encoding: "utf-8",
		stdio: ["ignore", "pipe", "pipe"],
		env: { ...process.env, PATH: `${fakeBinDir}:${process.env.PATH}`, CI: "1" },
	});
	return { status: result.status, output: stripAnsi(`${result.stdout ?? ""}${result.stderr ?? ""}`) };
}

/** Back to the state before a release attempt, so each test starts at 1.0.0 untagged. */
function resetProject(): void {
	git("reset", "--hard", baseSha);
	for (const tag of git("tag", "-l").split("\n").filter(Boolean)) {
		git("tag", "-d", tag);
	}
}

beforeAll(() => {
	workdir = mkdtempSync(join(tmpdir(), "shipx-publish-exit-"));
	projectDir = join(workdir, "project");
	fakeBinDir = join(workdir, "bin");
	mkdirSync(projectDir);
	mkdirSync(fakeBinDir);

	writeFileSync(
		join(projectDir, "package.json"),
		`${JSON.stringify({ name: FIXTURE_PKG_NAME, version: "1.0.0", main: "index.js", files: ["index.js"], license: "MIT" }, null, 2)}\n`,
	);
	writeFileSync(join(projectDir, "index.js"), "module.exports = {};\n");
	// No push, no GitHub release, no Homebrew: the commit and the tag are local,
	// and npm is the only step that reaches outside the project.
	writeFileSync(
		join(projectDir, ".shipxrc.json"),
		`${JSON.stringify({ steps: { push: false, githubRelease: false, npm: true, homebrew: false, watchCi: false }, changelogFile: "" }, null, 2)}\n`,
	);

	git("init", "-q", "-b", "main", ".");
	git("config", "user.email", "fixture@example.com");
	git("config", "user.name", "Fixture");
	git("add", "-A");
	// --no-verify: a throwaway fixture must not depend on the hooks installed on
	// whatever machine is running the tests.
	git("commit", "-q", "--no-verify", "-m", "feat: initial");
	baseSha = git("rev-parse", "HEAD").trim();
});

afterAll(() => {
	rmSync(workdir, { recursive: true, force: true });
});

describe("non-interactive release with a failing npm publish", () => {
	test("exits non-zero, warns, and leaves the tag in place", () => {
		writeFakeNpm(1);
		resetProject();

		const { status, output } = runRelease();

		expect(status).toBe(1);
		expect(output).toContain(`Half-shipped v1.0.1: the npm publish failed`);
		// The tag and the commit are already out; rolling back a release nobody
		// can confirm is worse than reporting it.
		expect(output).toContain("Not rolling back");
		expect(git("tag", "-l")).toContain("v1.0.1");
	});

	test("does not open the retry menu when there is nobody to answer it", () => {
		writeFakeNpm(1);
		resetProject();

		const { output } = runRelease();

		expect(output).not.toContain("How would you like to proceed?");
		expect(output).toContain("Use an npm automation token to publish unattended");
	});

	test("exits 0 when the publish succeeds", () => {
		writeFakeNpm(0);
		resetProject();

		const { status, output } = runRelease();

		expect(status).toBe(0);
		expect(output).toContain("Released v1.0.1");
		expect(git("tag", "-l")).toContain("v1.0.1");
	});
});
