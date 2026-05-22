import { describe, expect, test } from "bun:test";

// parseCommit and formatGrouped are internal; we expose them for testing only.
// Import via the barrel re-export added to changelog.ts.
import { formatGrouped, parseCommit } from "../steps/changelog.ts";

describe("parseCommit", () => {
	test("conventional commit: feat", () => {
		const c = parseCommit("abc1234 feat: add login");
		expect(c.hash).toBe("abc1234");
		expect(c.type).toBe("feat");
		expect(c.scope).toBe("");
		expect(c.description).toBe("add login");
		expect(c.breaking).toBe(false);
	});

	test("conventional commit with scope", () => {
		const c = parseCommit("abc1234 fix(auth): handle expired token");
		expect(c.type).toBe("fix");
		expect(c.scope).toBe("auth");
		expect(c.description).toBe("handle expired token");
	});

	test("breaking change via ! marker", () => {
		const c = parseCommit("abc1234 feat!: remove deprecated API");
		expect(c.breaking).toBe(true);
		expect(c.type).toBe("feat");
	});

	test("breaking change via BREAKING prefix", () => {
		const c = parseCommit("abc1234 breaking: drop Node 16");
		expect(c.breaking).toBe(true);
	});

	test("unknown type maps to other", () => {
		const c = parseCommit("abc1234 wip: half-done thing");
		expect(c.type).toBe("other");
	});

	test("non-conventional commit maps to other", () => {
		const c = parseCommit("abc1234 just a plain commit message");
		expect(c.type).toBe("other");
		expect(c.description).toBe("just a plain commit message");
	});

	test("malformed line (no hash)", () => {
		const c = parseCommit("no-hash-here");
		expect(c.hash).toBe("");
		expect(c.type).toBe("other");
	});
});

describe("formatGrouped", () => {
	test("empty array returns empty string", () => {
		expect(formatGrouped([])).toBe("");
	});

	test("groups commits under correct headings", () => {
		const commits = [
			parseCommit("aaa0001 feat: new thing"),
			parseCommit("bbb0002 fix: broken thing"),
		];
		const out = formatGrouped(commits);
		expect(out).toContain("### Features");
		expect(out).toContain("### Bug Fixes");
		expect(out).toContain("new thing");
		expect(out).toContain("broken thing");
	});

	test("breaking changes section appears first", () => {
		const commits = [
			parseCommit("aaa0001 feat: normal feature"),
			parseCommit("bbb0002 feat!: breaking feature"),
		];
		const out = formatGrouped(commits);
		const breakPos = out.indexOf("### Breaking Changes");
		const featPos = out.indexOf("### Features");
		expect(breakPos).toBeGreaterThanOrEqual(0);
		expect(breakPos).toBeLessThan(featPos);
	});

	test("breaking commit appears in Breaking Changes but not Features", () => {
		const commits = [parseCommit("aaa0001 feat!: drop old API")];
		const out = formatGrouped(commits);
		expect(out).toContain("### Breaking Changes");
		// Should not appear in Features section (breaking commits are filtered out of group lines)
		const featIdx = out.indexOf("### Features");
		expect(featIdx).toBe(-1);
	});

	test("scope is bolded in output", () => {
		const commits = [parseCommit("abc1234 fix(auth): fix token expiry")];
		const out = formatGrouped(commits);
		expect(out).toContain("**auth:**");
	});

	test("hash is appended to each line", () => {
		const commits = [parseCommit("deadbeef feat: great feature")];
		const out = formatGrouped(commits);
		expect(out).toContain("(deadbeef)");
	});
});
