import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bumpVersionFiles } from "./bump.ts";
import type { ResolvedConfig } from "../types.ts";

function makeConfig(root: string, overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
	return {
		root,
		dryRun: false,
		anyBranch: false,
		tag: "",
		packageJsonPaths: [],
		bumpFiles: [],
		cargoWorkspaces: [],
		testScript: "test",
		steps: {
			preflight: true, test: false, cleanup: false, changelog: true,
			bumpVersion: true, commit: true, tag: true, push: true,
			githubRelease: true, npm: true, homebrew: true,
		},
		git: {
			releaseBranch: "main", tagPrefix: "v", extraTags: [],
			commitMessage: "release: {tag}", commitFlags: [], pushFlags: [],
		},
		github: { draft: false },
		npm: { cwd: root, access: "public" },
		homebrew: { tapPath: "", formulaFile: "", repoSlug: "", commitMessage: "" },
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
