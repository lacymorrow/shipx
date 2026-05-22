import { describe, expect, test } from "bun:test";
import { parseCommit } from "./changelog.ts";

describe("parseCommit breaking-change detection (H8)", () => {
	test("feat!: <desc> is breaking", () => {
		expect(parseCommit("abc1234 feat!: drop node 18 support").breaking).toBe(true);
	});

	test("feat(api)!: <desc> with scope is breaking", () => {
		expect(parseCommit("abc1234 feat(api)!: rename foo").breaking).toBe(true);
	});

	test("subject starting with 'BREAKING' is breaking (case-insensitive)", () => {
		expect(parseCommit("abc1234 BREAKING: remove legacy flag").breaking).toBe(true);
		expect(parseCommit("abc1234 breaking change: remove legacy flag").breaking).toBe(true);
	});

	test("fix: handle !: operator is NOT breaking — `!:` is mid-subject, not a CC marker", () => {
		// This is the regression. `subject.includes("!:")` fired on this.
		expect(parseCommit("abc1234 fix: handle !:= operator in parser").breaking).toBe(false);
	});

	test("docs: explain breaking changes — body uses 'breaking' but type prefix says otherwise", () => {
		// Allowed by the spec — only the *subject* form should fire.
		expect(parseCommit("abc1234 docs: explain !: marker syntax").breaking).toBe(false);
	});

	test("plain fix: stays non-breaking", () => {
		expect(parseCommit("abc1234 fix: clamp value to zero").breaking).toBe(false);
	});

	test("regular feat: stays non-breaking", () => {
		expect(parseCommit("abc1234 feat: add new endpoint").breaking).toBe(false);
	});
});
