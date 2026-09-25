import { describe, test, expect, mock, beforeEach } from "bun:test";
import type { ResolvedConfig } from "../types.ts";

interface MockRun {
	databaseId: number;
	workflowName: string;
	headBranch: string;
	status: string;
	conclusion: string;
	url: string;
	createdAt: string;
	updatedAt: string;
}

const ghCalls: Array<{ file: string; args: string[] }> = [];
// Per-tag sequence of `gh run list` responses; each call consumes the next
// entry and the last one sticks once the sequence is exhausted.
let ghResponses: Record<string, MockRun[][]> = {};
const ghCallCount: Record<string, number> = {};

function mockGhRunList(tag: string): MockRun[] {
	const seq = ghResponses[tag] ?? [[]];
	const call = ghCallCount[tag] ?? 0;
	ghCallCount[tag] = call + 1;
	return seq[Math.min(call, seq.length - 1)];
}

mock.module("../utils.ts", () => ({
	run: async (file: string, args: string[]) => {
		ghCalls.push({ file, args });
		if (file === "gh" && args[0] === "run" && args[1] === "list") {
			const tag = args[args.indexOf("--branch") + 1];
			return JSON.stringify(mockGhRunList(tag));
		}
		return "";
	},
	sleep: (ms: number) => new Promise((r) => setTimeout(r, Math.min(ms, 1))),
	restoreCursor: () => {},
	errorText: (err: unknown) => (err instanceof Error ? err.message : String(err)),
}));

mock.module("@clack/prompts", () => ({
	spinner: () => ({ start: () => {}, stop: () => {}, message: () => {} }),
	log: { warn: () => {}, info: () => {}, error: () => {}, message: () => {}, success: () => {} },
}));

const { watchCiRuns, ciDelegatedSteps } = await import("./ci.ts");

function makeRun(overrides: Partial<MockRun>): MockRun {
	return {
		databaseId: 1,
		workflowName: "Release",
		headBranch: "v1.0.0",
		status: "completed",
		conclusion: "success",
		url: "https://github.com/o/r/actions/runs/1",
		createdAt: "2026-09-24T00:00:00Z",
		updatedAt: "2026-09-24T00:01:00Z",
		...overrides,
	};
}

function makeConfig(): ResolvedConfig {
	return { root: "/tmp/fake" } as Partial<ResolvedConfig> as ResolvedConfig;
}

const FAST = { discoveryTimeoutMs: 100, watchTimeoutMs: 1000, pollIntervalMs: 1 };

describe("ciDelegatedSteps", () => {
	test("empty when shipx runs every step itself", () => {
		expect(ciDelegatedSteps({ githubRelease: true, homebrew: true })).toEqual([]);
	});

	test("lists each step whose config delegates it to CI", () => {
		expect(ciDelegatedSteps({ githubRelease: false, homebrew: true })).toEqual(["GitHub Release"]);
		expect(ciDelegatedSteps({ githubRelease: false, homebrew: false })).toEqual([
			"GitHub Release",
			"Homebrew",
		]);
	});
});

describe("watchCiRuns", () => {
	beforeEach(() => {
		ghCalls.length = 0;
		ghResponses = {};
		for (const key of Object.keys(ghCallCount)) delete ghCallCount[key];
	});

	test("reports a failed run as failed and a successful one as succeeded", async () => {
		ghResponses = {
			"v1.0.0": [[makeRun({ databaseId: 1, headBranch: "v1.0.0" })]],
			"cua-v1.0.0": [
				[makeRun({ databaseId: 2, workflowName: "Release cua", headBranch: "cua-v1.0.0", status: "in_progress", conclusion: "" })],
				[makeRun({ databaseId: 2, workflowName: "Release cua", headBranch: "cua-v1.0.0", status: "completed", conclusion: "failure" })],
			],
		};

		const result = await watchCiRuns(makeConfig(), ["v1.0.0", "cua-v1.0.0"], FAST);

		expect(result.succeeded.map((r) => r.databaseId)).toEqual([1]);
		expect(result.failed.map((r) => r.databaseId)).toEqual([2]);
		expect(result.pending).toEqual([]);
		expect(result.missingTags).toEqual([]);
	});

	test("flags a tag that never triggers a run", async () => {
		ghResponses = {
			"v1.0.0": [[makeRun({ databaseId: 1 })]],
			"cua-v1.0.0": [[]],
		};

		const result = await watchCiRuns(makeConfig(), ["v1.0.0", "cua-v1.0.0"], FAST);

		expect(result.missingTags).toEqual(["cua-v1.0.0"]);
		expect(result.succeeded.map((r) => r.databaseId)).toEqual([1]);
		expect(result.failed).toEqual([]);
	});

	test("a missing tag does not hold the watch open once every found run is done", async () => {
		ghResponses = {
			"v1.0.0": [[makeRun({ databaseId: 1 })]],
			"cua-v1.0.0": [[]],
		};

		const started = Date.now();
		const result = await watchCiRuns(makeConfig(), ["v1.0.0", "cua-v1.0.0"], {
			...FAST,
			watchTimeoutMs: 5000,
		});

		expect(result.missingTags).toEqual(["cua-v1.0.0"]);
		// The missing tag is settled at the end of discovery; the watch must
		// end then, not poll on until the full watch cap expires.
		expect(Date.now() - started).toBeLessThan(2500);
	});

	test("reports runs still going at the watch cap as pending, not failed", async () => {
		ghResponses = {
			"v1.0.0": [[makeRun({ databaseId: 1, status: "in_progress", conclusion: "" })]],
		};

		const result = await watchCiRuns(makeConfig(), ["v1.0.0"], {
			...FAST,
			watchTimeoutMs: 30,
		});

		expect(result.pending.map((r) => r.databaseId)).toEqual([1]);
		expect(result.failed).toEqual([]);
		expect(result.succeeded).toEqual([]);
	});

	test("picks up a run that appears after the first poll", async () => {
		ghResponses = {
			"v1.0.0": [
				[makeRun({ databaseId: 1, status: "in_progress", conclusion: "" })],
				[
					makeRun({ databaseId: 1, status: "in_progress", conclusion: "" }),
					makeRun({ databaseId: 2, workflowName: "Docs", status: "queued", conclusion: "" }),
				],
				[
					makeRun({ databaseId: 1 }),
					makeRun({ databaseId: 2, workflowName: "Docs" }),
				],
			],
		};

		const result = await watchCiRuns(makeConfig(), ["v1.0.0"], FAST);

		expect(result.succeeded.map((r) => r.databaseId).sort()).toEqual([1, 2]);
		expect(result.pending).toEqual([]);
	});

	test("treats cancelled and timed-out conclusions as failures", async () => {
		ghResponses = {
			"v1.0.0": [[
				makeRun({ databaseId: 1, conclusion: "cancelled" }),
				makeRun({ databaseId: 2, conclusion: "timed_out" }),
				makeRun({ databaseId: 3, conclusion: "skipped" }),
			]],
		};

		const result = await watchCiRuns(makeConfig(), ["v1.0.0"], FAST);

		expect(result.failed.map((r) => r.databaseId).sort()).toEqual([1, 2]);
		expect(result.succeeded.map((r) => r.databaseId)).toEqual([3]);
	});
});
