import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
	buildNpmAuthOptions,
	batchPublishNpm,
	positionalArgs,
	reevaluateProjectPublishability,
	resolveBumpMode,
	summarizeBatch,
	watchBatchCi,
	type BatchCiProject,
	type BatchOutcome,
} from "./multi.ts";
import type { DiscoveredProject } from "./discover.ts";
import type { CiWatchResult } from "./steps/ci.ts";
import type { ResolvedConfig } from "./types.ts";

// ── Non-interactive batch mode (#70) ───────────────────────────────────

describe("positionalArgs", () => {
	test("keeps the bump level and drops the flags around it", () => {
		expect(positionalArgs(["--dry-run", "patch", "--yes"])).toEqual(["patch"]);
	});

	test("drops a flag's value as well as the flag", () => {
		expect(positionalArgs(["--tag", "next", "minor"])).toEqual(["minor"]);
		expect(positionalArgs(["--otp", "123456", "major"])).toEqual(["major"]);
	});

	test("no positionals is empty, not [undefined]", () => {
		expect(positionalArgs(["--dry-run", "--yes", "-y"])).toEqual([]);
	});
});

describe("resolveBumpMode", () => {
	test("a named level is taken from the command line", () => {
		expect(resolveBumpMode("patch", true)).toEqual({ kind: "named", mode: "patch" });
		expect(resolveBumpMode("minor", false)).toEqual({ kind: "named", mode: "minor" });
		expect(resolveBumpMode("major", true)).toEqual({ kind: "named", mode: "major" });
	});

	test("interactively, no level means ask", () => {
		expect(resolveBumpMode(undefined, false)).toEqual({ kind: "ask" });
	});

	// The reported bug: `shipx --multi --yes` opened the strategy select with
	// nothing on stdin and stalled having done nothing. There is no safe
	// default for a whole directory of projects, so it has to say so instead.
	test("unattended with no level is an error, not a prompt", () => {
		const resolution = resolveBumpMode(undefined, true);
		expect(resolution.kind).toBe("error");
		expect(resolution.kind === "error" && resolution.message).toContain("--multi patch");
	});

	test("an explicit version is refused rather than silently ignored", () => {
		const resolution = resolveBumpMode("2.0.0", false);
		expect(resolution.kind).toBe("error");
		expect(resolution.kind === "error" && resolution.message).toContain("2.0.0");
	});

	test("an unknown level is refused", () => {
		const resolution = resolveBumpMode("pacth", false);
		expect(resolution.kind).toBe("error");
		expect(resolution.kind === "error" && resolution.message).toContain("pacth");
	});
});

// ── Batch exit code and summary (#74) ──────────────────────────────────

function makeOutcome(overrides?: Partial<BatchOutcome>): BatchOutcome {
	return {
		prepared: [],
		prepareFailures: [],
		publishResults: [],
		publishSkipped: [],
		ci: [],
		nonInteractive: true,
		...overrides,
	};
}

function statusOf(verdict: ReturnType<typeof summarizeBatch>, name: string) {
	return verdict.statuses.find((s) => s.name === name)?.status;
}

describe("summarizeBatch", () => {
	test("everything landed: no failure, no problems", () => {
		const verdict = summarizeBatch(makeOutcome({
			prepared: [{ name: "pkg-a", tag: "v1.0.1" }],
			publishResults: [{ name: "pkg-a", success: true }],
		}));
		expect(verdict.failed).toBe(false);
		expect(verdict.problems).toEqual([]);
		expect(statusOf(verdict, "pkg-a")).toBe("released");
	});

	// The reported bug: phase 2 collected every publish result, printed
	// "Skipped/failed: <names>", then threw the list away. A batch where every
	// publish was rejected exited 0 with a ✓ per project.
	test("an unattended batch whose publishes all failed exits non-zero", () => {
		const verdict = summarizeBatch(makeOutcome({
			prepared: [{ name: "pkg-a", tag: "v1.0.1" }, { name: "pkg-b", tag: "v2.1.0" }],
			publishResults: [
				{ name: "pkg-a", success: false },
				{ name: "pkg-b", success: false },
			],
		}));
		expect(verdict.failed).toBe(true);
		expect(statusOf(verdict, "pkg-a")).toBe("publish-failed");
		expect(statusOf(verdict, "pkg-b")).toBe("publish-failed");
	});

	test("only the project whose publish failed is marked, so the summary says which shipped a tag with no package", () => {
		const verdict = summarizeBatch(makeOutcome({
			prepared: [{ name: "pkg-ok", tag: "v1.0.1" }, { name: "pkg-bad", tag: "v2.1.0" }],
			publishResults: [
				{ name: "pkg-ok", success: true },
				{ name: "pkg-bad", success: false },
			],
		}));
		expect(statusOf(verdict, "pkg-ok")).toBe("released");
		expect(statusOf(verdict, "pkg-bad")).toBe("publish-failed");
		expect(verdict.problems).toEqual(["1 npm publish failed"]);
	});

	test("interactively a failed publish is reported but does not fail the run", () => {
		// Mirrors the single-project rule (#69): with someone watching,
		// publishNpm returning false can be a deliberate skip, and they have
		// already read the warning.
		const verdict = summarizeBatch(makeOutcome({
			nonInteractive: false,
			prepared: [{ name: "pkg-a", tag: "v1.0.1" }],
			publishResults: [{ name: "pkg-a", success: false }],
		}));
		expect(verdict.failed).toBe(false);
		expect(statusOf(verdict, "pkg-a")).toBe("publish-failed");
		expect(verdict.problems).toEqual(["1 npm publish failed"]);
	});

	test("a cancelled auth prompt marks every package as tagged without a package", () => {
		const verdict = summarizeBatch(makeOutcome({
			nonInteractive: false,
			prepared: [{ name: "pkg-a", tag: "v1.0.1" }],
			publishSkipped: ["pkg-a"],
		}));
		expect(statusOf(verdict, "pkg-a")).toBe("publish-skipped");
		expect(verdict.problems).toEqual(["1 npm publish skipped"]);
	});

	test("a prepare that threw always fails the run, attended or not", () => {
		for (const nonInteractive of [true, false]) {
			const verdict = summarizeBatch(makeOutcome({
				nonInteractive,
				prepareFailures: ["pkg-broken"],
			}));
			expect(verdict.failed).toBe(true);
			expect(statusOf(verdict, "pkg-broken")).toBe("prepare-failed");
		}
	});

	test("a project that failed before pushing still appears in the summary", () => {
		// It never reaches `prepared`, so it used to vanish from the summary.
		const verdict = summarizeBatch(makeOutcome({
			prepared: [{ name: "pkg-ok", tag: "v1.0.1" }],
			prepareFailures: ["pkg-broken"],
		}));
		expect(verdict.statuses.map((s) => s.name)).toEqual(["pkg-ok", "pkg-broken"]);
		expect(verdict.statuses.find((s) => s.name === "pkg-broken")?.tag).toBe("");
	});

	test("a failed CI run still fails the run", () => {
		const verdict = summarizeBatch(makeOutcome({
			prepared: [{ name: "pkg-a", tag: "v1.0.1" }],
			publishResults: [{ name: "pkg-a", success: true }],
			ci: [{ name: "pkg-a", result: makeCiResult({ failed: [makeCiRun()] }) }],
		}));
		expect(verdict.failed).toBe(true);
		expect(statusOf(verdict, "pkg-a")).toBe("ci-failed");
	});

	test("a failed publish outranks a pending CI run in the summary line", () => {
		// The publish is the thing that did not happen; CI being mid-flight is
		// not the headline.
		const verdict = summarizeBatch(makeOutcome({
			prepared: [{ name: "pkg-a", tag: "v1.0.1" }],
			publishResults: [{ name: "pkg-a", success: false }],
			ci: [{ name: "pkg-a", result: makeCiResult({ pending: [makeCiRun()] }) }],
		}));
		expect(statusOf(verdict, "pkg-a")).toBe("publish-failed");
	});
});

// ── Auth option selection ──────────────────────────────────────────────

describe("buildNpmAuthOptions", () => {
	test("single package: web and otp are both available", () => {
		const options = buildNpmAuthOptions(1);
		expect(options.map((o) => o.value)).toContain("web");
		expect(options.map((o) => o.value)).toContain("otp");
	});

	test("multiple packages: web auth is first and marked recommended", () => {
		const options = buildNpmAuthOptions(3);
		expect(options[0].value).toBe("web");
		expect(options[0].hint?.toLowerCase()).toContain("recommended");
	});

	test("multiple packages: OTP option warns it will prompt per package", () => {
		const options = buildNpmAuthOptions(3);
		const otpOption = options.find((o) => o.value === "otp");
		expect(otpOption).toBeDefined();
		expect(otpOption!.hint?.toLowerCase()).toMatch(/per.?package|each package|fresh/);
	});

	test("single package: OTP hint does not mention per-package", () => {
		const options = buildNpmAuthOptions(1);
		const otpOption = options.find((o) => o.value === "otp");
		expect(otpOption).toBeDefined();
		expect(otpOption!.hint?.toLowerCase()).not.toMatch(/per.?package/);
	});
});

// ── Batch publish loop ─────────────────────────────────────────────────

function makeFakeConfig(name: string): ResolvedConfig {
	return {
		root: `/tmp/fake/${name}`,
		configFile: "shipx.config.mts",
		dryRun: false,
		anyBranch: false,
		tag: "v1.0.0",
		packageJsonPaths: ["package.json"],
		versionSource: "",
		bumpFiles: [],
		changelogFile: "",
		cargoWorkspaces: [],
		testScript: "test",
		steps: {
			preflight: true, test: false, cleanup: false, changelog: false,
			bumpVersion: true, commit: true, tag: true, push: true,
			githubRelease: false, npm: true, homebrew: false, watchCi: true,
		},
		git: {
			releaseBranch: "main", tagPrefix: "v", extraTags: [],
			commitMessage: "release: {tag}", commitFlags: ["--no-verify"], pushFlags: ["--no-verify"],
		},
		github: { draft: false, assets: [] },
		npm: { cwd: `/tmp/fake/${name}`, access: "public", targets: [{ cwd: `/tmp/fake/${name}`, access: "public" }], autoDetectedReason: "" },
		homebrew: { tapPath: "", formulaFile: "", repoSlug: "", commitMessage: "", binaryAssets: {} },
		hooks: {},
	};
}

describe("batchPublishNpm — OTP per-package", () => {
	test("otp auth collects a fresh OTP for each package, not one shared", async () => {
		const otpValues: string[] = [];
		const promptedFor: string[] = [];
		const projects = [
			{ dirName: "pkg-a", config: makeFakeConfig("pkg-a"), isBeta: false },
			{ dirName: "pkg-b", config: makeFakeConfig("pkg-b"), isBeta: false },
			{ dirName: "pkg-c", config: makeFakeConfig("pkg-c"), isBeta: false },
		];

		let otpCallCount = 0;
		const mockPromptOtp = async (dirName: string) => {
			otpCallCount++;
			promptedFor.push(dirName);
			return `${100000 + otpCallCount}`;
		};

		const mockPublish = async (
			_config: ResolvedConfig,
			_isBeta: boolean,
			opts?: { otp?: string; webAuth?: boolean },
		): Promise<boolean> => {
			if (opts?.otp) otpValues.push(opts.otp);
			return true;
		};

		await batchPublishNpm(projects, "otp", {
			publishFn: mockPublish,
			promptOtpFn: mockPromptOtp,
		});

		expect(otpCallCount).toBe(3);
		expect(new Set(otpValues).size).toBe(3);
		expect(otpValues).toEqual(["100001", "100002", "100003"]);
		expect(promptedFor).toEqual(["pkg-a", "pkg-b", "pkg-c"]);
	});

	test("web auth does not prompt for OTP at all", async () => {
		let otpCallCount = 0;
		const projects = [
			{ dirName: "pkg-a", config: makeFakeConfig("pkg-a"), isBeta: false },
			{ dirName: "pkg-b", config: makeFakeConfig("pkg-b"), isBeta: false },
		];

		const mockPublish = async (): Promise<boolean> => true;
		const mockPromptOtp = async () => {
			otpCallCount++;
			return "123456";
		};

		await batchPublishNpm(projects, "web", {
			publishFn: mockPublish,
			promptOtpFn: mockPromptOtp,
		});

		expect(otpCallCount).toBe(0);
	});

	test("none auth does not prompt for OTP", async () => {
		let otpCallCount = 0;
		const projects = [
			{ dirName: "pkg-a", config: makeFakeConfig("pkg-a"), isBeta: false },
		];

		const mockPublish = async (): Promise<boolean> => true;
		const mockPromptOtp = async () => {
			otpCallCount++;
			return "123456";
		};

		await batchPublishNpm(projects, "none", {
			publishFn: mockPublish,
			promptOtpFn: mockPromptOtp,
		});

		expect(otpCallCount).toBe(0);
	});

	test("returns per-project success/failure results", async () => {
		let callIndex = 0;
		const projects = [
			{ dirName: "pkg-ok", config: makeFakeConfig("pkg-ok"), isBeta: false },
			{ dirName: "pkg-fail", config: makeFakeConfig("pkg-fail"), isBeta: false },
		];

		const mockPublish = async (): Promise<boolean> => {
			callIndex++;
			return callIndex !== 2;
		};

		const results = await batchPublishNpm(projects, "web", {
			publishFn: mockPublish,
			promptOtpFn: async () => "123456",
		});

		expect(results).toEqual([
			{ name: "pkg-ok", success: true },
			{ name: "pkg-fail", success: false },
		]);
	});
});

// ── Batch CI watch (issue #62) ─────────────────────────────────────────

function makeCiResult(overrides?: Partial<CiWatchResult>): CiWatchResult {
	return { succeeded: [], failed: [], pending: [], missingTags: [], ...overrides };
}

function makeCiRun(): CiWatchResult["failed"][number] {
	return {
		databaseId: 1,
		workflowName: "release",
		headBranch: "v1.0.1",
		status: "completed",
		conclusion: "failure",
		url: "https://example.com/run/1",
		createdAt: "2026-01-01T00:00:00Z",
		updatedAt: "2026-01-01T00:01:00Z",
	};
}

function makeCiProject(
	name: string,
	configure?: (config: ResolvedConfig) => void,
): BatchCiProject {
	const config = makeFakeConfig(name);
	// makeFakeConfig delegates githubRelease and homebrew to CI by default.
	configure?.(config);
	return { dirName: name, config, pushedTags: [`v1.0.0-${name}`] };
}

describe("watchBatchCi", () => {
	const ghAvailable = async () => true;

	test("watches each project that delegates a step, with its own config and tags", async () => {
		const watched: { root: string; tags: string[] }[] = [];
		const projects = [makeCiProject("pkg-a"), makeCiProject("pkg-b")];

		const results = await watchBatchCi(projects, {
			watchFn: async (config, tags) => {
				watched.push({ root: config.root, tags });
				return makeCiResult();
			},
			isGhAvailableFn: ghAvailable,
		});

		expect(watched).toEqual([
			{ root: "/tmp/fake/pkg-a", tags: ["v1.0.0-pkg-a"] },
			{ root: "/tmp/fake/pkg-b", tags: ["v1.0.0-pkg-b"] },
		]);
		expect(results.map((r) => r.name)).toEqual(["pkg-a", "pkg-b"]);
	});

	test("skips projects with no CI-delegated steps", async () => {
		let watchCount = 0;
		const local = makeCiProject("all-local", (config) => {
			config.steps.githubRelease = true;
			config.steps.homebrew = true;
		});

		const results = await watchBatchCi([local], {
			watchFn: async () => {
				watchCount++;
				return makeCiResult();
			},
			isGhAvailableFn: ghAvailable,
		});

		expect(watchCount).toBe(0);
		expect(results).toEqual([]);
	});

	test("skips projects with watchCi disabled", async () => {
		let watchCount = 0;
		const optedOut = makeCiProject("opted-out", (config) => {
			config.steps.watchCi = false;
		});

		await watchBatchCi([optedOut, makeCiProject("pkg-b")], {
			watchFn: async () => {
				watchCount++;
				return makeCiResult();
			},
			isGhAvailableFn: ghAvailable,
		});

		expect(watchCount).toBe(1);
	});

	test("skips projects that pushed no tags", async () => {
		let watchCount = 0;
		const unpushed = makeCiProject("unpushed");
		unpushed.pushedTags = [];

		const results = await watchBatchCi([unpushed], {
			watchFn: async () => {
				watchCount++;
				return makeCiResult();
			},
			isGhAvailableFn: ghAvailable,
		});

		expect(watchCount).toBe(0);
		expect(results).toEqual([]);
	});

	test("skips projects with push disabled", async () => {
		let watchCount = 0;
		const noPush = makeCiProject("no-push", (config) => {
			config.steps.push = false;
		});

		await watchBatchCi([noPush], {
			watchFn: async () => {
				watchCount++;
				return makeCiResult();
			},
			isGhAvailableFn: ghAvailable,
		});

		expect(watchCount).toBe(0);
	});

	test("gh unavailable: watches nothing, returns empty", async () => {
		let watchCount = 0;
		const results = await watchBatchCi([makeCiProject("pkg-a")], {
			watchFn: async () => {
				watchCount++;
				return makeCiResult();
			},
			isGhAvailableFn: async () => false,
		});

		expect(watchCount).toBe(0);
		expect(results).toEqual([]);
	});

	test("returns per-project results so callers can fail the batch", async () => {
		const failedRun = {
			databaseId: 1,
			workflowName: "release",
			headBranch: "v1.0.0-pkg-bad",
			status: "completed",
			conclusion: "failure",
			url: "https://example.com/run/1",
			createdAt: "2026-01-01T00:00:00Z",
			updatedAt: "2026-01-01T00:01:00Z",
		};

		const results = await watchBatchCi(
			[makeCiProject("pkg-ok"), makeCiProject("pkg-bad")],
			{
				watchFn: async (config) =>
					config.root.endsWith("pkg-bad")
						? makeCiResult({ failed: [failedRun] })
						: makeCiResult(),
				isGhAvailableFn: ghAvailable,
			},
		);

		expect(results.find((r) => r.name === "pkg-ok")?.result.failed).toEqual([]);
		expect(results.find((r) => r.name === "pkg-bad")?.result.failed).toEqual([failedRun]);
	});
});

describe("reevaluateProjectPublishability", () => {
	let root: string;

	beforeEach(() => {
		root = mkdtempSync(resolve(tmpdir(), "shipx-reeval-"));
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	function writePkg(dir: string, pkg: object): void {
		mkdirSync(dir, { recursive: true });
		writeFileSync(resolve(dir, "package.json"), JSON.stringify(pkg));
	}

	function makeProject(path: string): DiscoveredProject {
		return {
			name: "x",
			dirName: "x",
			path,
			version: "1.0.0",
			private: false,
			hasNpm: false,
			changeCount: 0,
			lastTag: "",
			branch: "main",
			dirty: false,
			archived: false,
		};
	}

	function makeConfig(cwd: string, npmEnabled = true): ResolvedConfig {
		const cfg = makeFakeConfig("reeval");
		cfg.steps.npm = npmEnabled;
		cfg.npm.targets = [{ cwd, access: "public" }];
		cfg.npm.cwd = cwd;
		return cfg;
	}

	test("publishable target: hasNpm becomes true", () => {
		writePkg(root, { name: "pkg", bin: "x.js" });
		const project = makeProject(root);
		reevaluateProjectPublishability(project, makeConfig(root));
		expect(project.hasNpm).toBe(true);
		expect(project.name).toBe("pkg");
	});

	test('private target: hasNpm becomes false', () => {
		writePkg(root, { name: "pkg", bin: "x.js", private: true });
		const project = makeProject(root);
		reevaluateProjectPublishability(project, makeConfig(root));
		expect(project.hasNpm).toBe(false);
		expect(project.private).toBe(true);
	});

	// Regression: the previous inline `pkg.private !== true && !pkg.workspaces`
	// check would have marked this publishable, missing the entry-points gap
	// that caused the original npx-lacy disaster. Reported on PR #49 by Gemini.
	test("target with no bin/main/exports/module: hasNpm becomes false", () => {
		writePkg(root, { name: "pkg" });
		const project = makeProject(root);
		project.hasNpm = true; // simulate stale "publishable" state
		reevaluateProjectPublishability(project, makeConfig(root));
		expect(project.hasNpm).toBe(false);
	});

	test("steps.npm disabled: hasNpm is forced false regardless of pkg", () => {
		writePkg(root, { name: "pkg", bin: "x.js" });
		const project = makeProject(root);
		project.hasNpm = true;
		reevaluateProjectPublishability(project, makeConfig(root, false));
		expect(project.hasNpm).toBe(false);
	});

	test("unreadable target: hasNpm becomes false, does not throw", () => {
		// No package.json written.
		const project = makeProject(root);
		project.hasNpm = true;
		expect(() => reevaluateProjectPublishability(project, makeConfig(root))).not.toThrow();
		expect(project.hasNpm).toBe(false);
	});
});
