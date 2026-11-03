import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bumpVersionFiles, getFilesToStage } from "./bump.ts";
import type { ResolvedConfig } from "../types.ts";

function makeConfig(root: string, overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
	return {
		root,
		configFile: "shipx.config.mts",
		dryRun: false,
		anyBranch: false,
		tag: "",
		packageJsonPaths: [],
		versionSource: "",
		bumpFiles: [],
		changelogFile: "",
		cargoWorkspaces: [],
		testScript: "test",
		steps: {
			preflight: true, test: false, cleanup: false, changelog: true,
			bumpVersion: true, commit: true, tag: true, push: true,
			githubRelease: true, npm: true, homebrew: true, watchCi: true, xcode: true,
		},
		git: {
			releaseBranch: "main", tagPrefix: "v", extraTags: [],
			commitMessage: "release: {tag}", commitFlags: [], pushFlags: [],
		},
		github: { draft: false, assets: [] },
		npm: { cwd: root, access: "public", targets: [{ cwd: root, access: "public" }], autoDetectedReason: "" },
		homebrew: { tapPath: "", formulaFile: "", repoSlug: "", commitMessage: "", binaryAssets: {} },
		xcode: { enabled: false, versionFile: "", buildNumber: "commitCount", buildNumberOffset: 0, generate: true, scheme: "", platforms: ["ios"], exportOptionsPlist: "", ascKey: null, upload: true },
		hooks: {},
		...overrides,
	};
}

describe("bumpVersionFiles (N2)", () => {
	test("bumps package.json version", () => {
		const dir = mkdtempSync(join(tmpdir(), "shipx-bump-"));
		try {
			writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x", version: "1.0.0" }, null, 2));
			const cfg = makeConfig(dir, { packageJsonPaths: ["package.json"] });
			bumpVersionFiles(cfg, "1.0.1");
			const written = JSON.parse(readFileSync(join(dir, "package.json"), "utf-8"));
			expect(written.version).toBe("1.0.1");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("non-matching bumpFiles pattern leaves file unchanged (no silent corruption)", () => {
		// Regression: previously `.replace()` returned the original string when
		// the pattern didn't match, then we'd write that unchanged content back
		// AND stage it for commit, masking the misconfiguration.
		const dir = mkdtempSync(join(tmpdir(), "shipx-bump-"));
		try {
			const filePath = join(dir, "Cargo.toml");
			const original = `[package]\nname = "x"\nversion = "1.0.0"\n`;
			writeFileSync(filePath, original);

			const cfg = makeConfig(dir, {
				packageJsonPaths: [],
				bumpFiles: [
					{
						path: "Cargo.toml",
						// Intentionally wrong pattern — won't match the file content.
						pattern: /completely-wrong-pattern-(\d+)/,
						replacement: (v) => `version = "${v}"`,
					},
				],
			});

			bumpVersionFiles(cfg, "1.0.1");

			// File content stays exactly the same byte-for-byte.
			const after = readFileSync(filePath, "utf-8");
			expect(after).toBe(original);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("matching bumpFiles pattern rewrites file", () => {
		const dir = mkdtempSync(join(tmpdir(), "shipx-bump-"));
		try {
			const filePath = join(dir, "version.ts");
			writeFileSync(filePath, `export const VERSION = "1.0.0";\n`);

			const cfg = makeConfig(dir, {
				bumpFiles: [
					{
						path: "version.ts",
						pattern: /VERSION = "[^"]+"/,
						replacement: (v) => `VERSION = "${v}"`,
					},
				],
			});

			bumpVersionFiles(cfg, "1.0.1");
			expect(readFileSync(filePath, "utf-8")).toContain(`VERSION = "1.0.1"`);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("bumpVersionFiles for an Xcode project", () => {
	test("rewrites MARKETING_VERSION without a beta suffix and stages the version file", () => {
		const root = mkdtempSync(join(tmpdir(), "shipx-bump-xcode-"));
		try {
			writeFileSync(join(root, "project.yml"), 'name: App\nsettings:\n  base:\n    MARKETING_VERSION: "1.0.0"\n    CURRENT_PROJECT_VERSION: "4"\n');
			const config = makeConfig(root);
			config.xcode = { ...config.xcode, enabled: true, versionFile: "project.yml", buildNumber: "increment" };
			bumpVersionFiles(config, "1.1.0-beta.0");
			const out = readFileSync(join(root, "project.yml"), "utf-8");
			expect(out).toContain('MARKETING_VERSION: "1.1.0"');
			expect(out).toContain('CURRENT_PROJECT_VERSION: "5"');
			expect(getFilesToStage(config)).toEqual(["project.yml"]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("getFilesToStage for a tracked .xcodeproj", () => {
	test("stages the tracked project.pbxproj, and not an untracked one", () => {
		const root = mkdtempSync(join(tmpdir(), "shipx-stage-xcode-"));
		try {
			execFileSync("git", ["init", "-q"], { cwd: root });
			mkdirSync(join(root, "A.xcodeproj"));
			mkdirSync(join(root, "B.xcodeproj"));
			writeFileSync(join(root, "A.xcodeproj/project.pbxproj"), "x");
			writeFileSync(join(root, "B.xcodeproj/project.pbxproj"), "x");
			execFileSync("git", ["add", "A.xcodeproj/project.pbxproj"], { cwd: root });
			const config = makeConfig(root);
			config.xcode = { ...config.xcode, enabled: true, versionFile: "project.yml" };
			expect(getFilesToStage(config)).toEqual(["project.yml", "A.xcodeproj/project.pbxproj"]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
