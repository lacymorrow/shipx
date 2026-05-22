import { describe, expect, test } from "bun:test";
import { PartialPushError, planRollback } from "../steps/git.ts";

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
