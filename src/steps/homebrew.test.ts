import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ResolvedConfig } from "../types.ts";

const execCalls: Array<{ file: string; args: string[]; opts?: Record<string, unknown> }> = [];
let tapDefaultBranch = "master";
let gitStatusOutput = "";

mock.module("../utils.ts", () => ({
	exec: (file: string, args: string[], opts?: Record<string, unknown>) => {
		execCalls.push({ file, args, opts });
		if (file === "git" && args[0] === "status" && args[1] === "--porcelain") {
			return gitStatusOutput;
		}
		if (file === "curl") {
			// Short-circuit the tarball download: throwing here lets publishHomebrew
			// exit cleanly after the checkout/pull calls we want to assert on, without
			// requiring a real fixture file or network access.
			throw new Error("mock: skipping download");
		}
		return "";
	},
	detectDefaultBranch: () => tapDefaultBranch,
	errorText: (err: unknown) => (err instanceof Error ? err.message : String(err)),
}));

mock.module("@clack/prompts", () => ({
	spinner: () => ({ start: () => {}, stop: () => {} }),
	log: { warn: () => {}, info: () => {}, error: () => {} },
	confirm: async () => true,
	isCancel: () => false,
}));

const { publishHomebrew } = await import("./homebrew.ts");

function makeConfig(tapPath: string): ResolvedConfig {
	const partial: Partial<ResolvedConfig> = {
		homebrew: {
			tapPath,
			formulaFile: "Formula/test.rb",
			repoSlug: "test/repo",
			commitMessage: "Update {formula} to {tag}",
			binaryAssets: {},
		},
		dryRun: false,
	};
	return partial as ResolvedConfig;
}

describe("publishHomebrew", () => {
	let tapDir: string;

	beforeEach(() => {
		execCalls.length = 0;
		tapDefaultBranch = "master";
		gitStatusOutput = "";
		tapDir = mkdtempSync(join(tmpdir(), "shipx-homebrew-test-"));
		mkdirSync(join(tapDir, "Formula"), { recursive: true });
		writeFileSync(
			join(tapDir, "Formula", "test.rb"),
			'url "https://github.com/test/repo/archive/refs/tags/v1.0.0.tar.gz"\nsha256 "0000000000000000000000000000000000000000000000000000000000000000"\n',
		);
	});

	afterEach(() => {
		rmSync(tapDir, { recursive: true, force: true });
	});

	test("uses detected default branch instead of hardcoded main", async () => {
		tapDefaultBranch = "master";
		await publishHomebrew(makeConfig(tapDir), "v1.1.0", { skipConfirm: true });

		const checkoutCall = execCalls.find(
			(c) => c.file === "git" && c.args[0] === "checkout",
		);
		expect(checkoutCall).toBeDefined();
		expect(checkoutCall!.args[1]).toBe("master");

		const pullCall = execCalls.find(
			(c) => c.file === "git" && c.args[0] === "pull",
		);
		expect(pullCall).toBeDefined();
		expect(pullCall!.args).toContain("master");
	});

	test("aborts when tap working tree is dirty", async () => {
		gitStatusOutput = " M Formula/test.rb\n";
		await publishHomebrew(makeConfig(tapDir), "v1.1.0", { skipConfirm: true });

		const checkoutCall = execCalls.find(
			(c) => c.file === "git" && c.args[0] === "checkout",
		);
		expect(checkoutCall).toBeUndefined();
	});
});
