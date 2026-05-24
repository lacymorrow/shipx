import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { buildNpmAuthOptions, batchPublishNpm, reevaluateProjectPublishability } from "./multi.ts";
import type { DiscoveredProject } from "./discover.ts";
import type { ResolvedConfig } from "./types.ts";

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
		dryRun: false,
		anyBranch: false,
		tag: "v1.0.0",
		packageJsonPaths: ["package.json"],
		versionSource: "",
		bumpFiles: [],
		cargoWorkspaces: [],
		testScript: "test",
		steps: {
			preflight: true, test: false, cleanup: false, changelog: false,
			bumpVersion: true, commit: true, tag: true, push: true,
			githubRelease: false, npm: true, homebrew: false,
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
