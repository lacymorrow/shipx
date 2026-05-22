import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitAndTag, tagExists } from "./git.ts";
import type { ResolvedConfig } from "../types.ts";

function git(cwd: string, args: string[]): void {
	execFileSync("git", args, { cwd, stdio: "pipe" });
}

function initRepo(): string {
	const dir = mkdtempSync(join(tmpdir(), "shipx-git-test-"));
	git(dir, ["init", "-q", "--initial-branch=main"]);
	git(dir, ["config", "user.email", "test@example.com"]);
	git(dir, ["config", "user.name", "Test"]);
	git(dir, ["config", "commit.gpgsign", "false"]);
	git(dir, ["config", "tag.gpgsign", "false"]);
	writeFileSync(join(dir, "seed.txt"), "seed\n");
	git(dir, ["add", "seed.txt"]);
	git(dir, ["commit", "-q", "-m", "seed"]);
	return dir;
}

function makeConfig(root: string): ResolvedConfig {
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
			commitMessage: "release: {tag}",
			commitFlags: ["--no-verify"],
			pushFlags: ["--no-verify"],
		},
		github: { draft: false },
		npm: { cwd: root, access: "public", targets: [{ cwd: root, access: "public" }] },
		homebrew: { tapPath: "", formulaFile: "", repoSlug: "", commitMessage: "" },
		hooks: {},
	};
}

describe("tagExists (M9)", () => {
	test("false when tag absent", () => {
		const dir = initRepo();
		try {
			expect(tagExists(dir, "v9.9.9")).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("true when tag present", () => {
		const dir = initRepo();
		try {
			git(dir, ["tag", "v1.0.0"]);
			expect(tagExists(dir, "v1.0.0")).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("commitAndTag tag-collision guard (M9)", () => {
	test("throws BEFORE committing when the target tag already exists", () => {
		const dir = initRepo();
		try {
			git(dir, ["tag", "v1.0.0"]);
			const before = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf-8" }).trim();

			// Stage a tracked change that would otherwise be committed.
			writeFileSync(join(dir, "package.json"), JSON.stringify({ version: "1.0.0" }));

			const cfg = makeConfig(dir);
			expect(() => commitAndTag(cfg, "v1.0.0", "1.0.0", ["package.json"])).toThrow(/already exist/i);

			// HEAD didn't advance — the throw aborted before `git commit`.
			const after = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf-8" }).trim();
			expect(after).toBe(before);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("creates commit and tag when target tag is fresh", () => {
		const dir = initRepo();
		try {
			writeFileSync(join(dir, "package.json"), JSON.stringify({ version: "1.0.1" }));
			const cfg = makeConfig(dir);
			commitAndTag(cfg, "v1.0.1", "1.0.1", ["package.json"]);
			expect(tagExists(dir, "v1.0.1")).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
