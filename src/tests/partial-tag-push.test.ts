import { describe, expect, test } from "bun:test";
import { PartialPushError, planRollback, type RollbackPlan } from "../steps/git.ts";

describe("PartialPushError", () => {
	test("carries pushed tags through the error", () => {
		const err = new PartialPushError("tag push failed", ["v1.0.0"], true);
		expect(err.pushedTags).toEqual(["v1.0.0"]);
		expect(err.branchPushed).toBe(true);
		expect(err).toBeInstanceOf(Error);
		expect(err.message).toBe("tag push failed");
	});

	test("defaults branchPushed to false", () => {
		const err = new PartialPushError("push failed", []);
		expect(err.branchPushed).toBe(false);
		expect(err.pushedTags).toEqual([]);
	});
});

describe("planRollback", () => {
	test("no tags pushed → local-only cleanup, no remote commands", () => {
		const plan = planRollback(["v1.0.0", "extra-v1.0.0"], []);
		expect(plan.localTagsToDelete).toEqual(["v1.0.0", "extra-v1.0.0"]);
		expect(plan.remoteTagsToDelete).toEqual([]);
		expect(plan.branchPushed).toBe(false);
	});

	test("all tags pushed → remote cleanup for all", () => {
		const plan = planRollback(
			["v1.0.0", "extra-v1.0.0"],
			["v1.0.0", "extra-v1.0.0"],
		);
		expect(plan.localTagsToDelete).toEqual(["v1.0.0", "extra-v1.0.0"]);
		expect(plan.remoteTagsToDelete).toEqual(["v1.0.0", "extra-v1.0.0"]);
		expect(plan.branchPushed).toBe(true);
	});

	test("partial push → remote cleanup only for pushed tags", () => {
		const allTags = ["v1.0.0", "cua-v1.0.0", "juno-v1.0.0"];
		const pushedTags = ["v1.0.0"];
		const plan = planRollback(allTags, pushedTags);
		expect(plan.localTagsToDelete).toEqual(allTags);
		expect(plan.remoteTagsToDelete).toEqual(["v1.0.0"]);
		expect(plan.branchPushed).toBe(true);
	});

	test("branchPushed reflects whether any tag reached remote", () => {
		const noPush = planRollback(["v1.0.0"], []);
		expect(noPush.branchPushed).toBe(false);

		const somePush = planRollback(["v1.0.0"], ["v1.0.0"]);
		expect(somePush.branchPushed).toBe(true);
	});

	test("explicit branchPushed override", () => {
		const plan = planRollback(["v1.0.0"], [], true);
		expect(plan.branchPushed).toBe(true);
		expect(plan.remoteTagsToDelete).toEqual([]);
	});

	test("single tag, pushed → correct plan", () => {
		const plan = planRollback(["v2.0.0"], ["v2.0.0"]);
		expect(plan.localTagsToDelete).toEqual(["v2.0.0"]);
		expect(plan.remoteTagsToDelete).toEqual(["v2.0.0"]);
		expect(plan.branchPushed).toBe(true);
	});
});

describe("partial-push → rollback integration", () => {
	test("PartialPushError drives planRollback with correct pushed subset", () => {
		const mainTag = "v1.2.0";
		const extraTags = ["cua-v1.2.0", "juno-v1.2.0"];
		const allTags = [mainTag, ...extraTags];

		const err = new PartialPushError(
			"failed to push juno-v1.2.0",
			["v1.2.0", "cua-v1.2.0"],
			true,
		);

		const plan = planRollback(allTags, err.pushedTags, err.branchPushed);

		expect(plan.localTagsToDelete).toEqual(allTags);
		expect(plan.remoteTagsToDelete).toEqual(["v1.2.0", "cua-v1.2.0"]);
		expect(plan.remoteTagsToDelete).not.toContain("juno-v1.2.0");
		expect(plan.branchPushed).toBe(true);
	});

	test("catch path: error.pushedTags propagates to rollback, not the full list", () => {
		const mainTag = "v3.0.0";
		const extraTags = ["extra-v3.0.0"];
		const allTags = [mainTag, ...extraTags];

		// Simulate: main tag pushed, extra tag fails
		const err = new PartialPushError("network timeout", [mainTag], true);

		// This is the exact logic from cli.ts catch block
		let plan: RollbackPlan | null = null;
		try {
			throw err;
		} catch (caught) {
			if (caught instanceof PartialPushError) {
				plan = planRollback(allTags, caught.pushedTags, caught.branchPushed);
			}
		}

		expect(plan).not.toBeNull();
		expect(plan!.remoteTagsToDelete).toEqual([mainTag]);
		expect(plan!.remoteTagsToDelete).not.toContain("extra-v3.0.0");
		expect(plan!.localTagsToDelete).toEqual(allTags);
	});

	test("no tags pushed before failure → remote list empty", () => {
		const allTags = ["v1.0.0", "extra-v1.0.0"];
		const err = new PartialPushError("auth failed on first tag", [], true);

		const plan = planRollback(allTags, err.pushedTags, err.branchPushed);

		expect(plan.remoteTagsToDelete).toEqual([]);
		expect(plan.localTagsToDelete).toEqual(allTags);
		expect(plan.branchPushed).toBe(true);
	});
});
