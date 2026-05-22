import { describe, expect, test } from "bun:test";
import { compareSemver } from "../registry.ts";

describe("compareSemver", () => {
	test("equal versions return 0", () => {
		expect(compareSemver("1.2.3", "1.2.3")).toBe(0);
	});

	test("major wins", () => {
		expect(compareSemver("2.0.0", "1.9.9")).toBe(1);
		expect(compareSemver("1.9.9", "2.0.0")).toBe(-1);
	});

	test("minor wins when major equal", () => {
		expect(compareSemver("1.2.0", "1.1.9")).toBe(1);
		expect(compareSemver("1.1.9", "1.2.0")).toBe(-1);
	});

	test("patch wins when major.minor equal", () => {
		expect(compareSemver("1.2.4", "1.2.3")).toBe(1);
		expect(compareSemver("1.2.3", "1.2.4")).toBe(-1);
	});

	test("release beats pre-release of same version", () => {
		expect(compareSemver("1.2.3", "1.2.3-beta.0")).toBe(1);
		expect(compareSemver("1.2.3-beta.0", "1.2.3")).toBe(-1);
	});

	test("higher beta number beats lower", () => {
		expect(compareSemver("1.2.3-beta.1", "1.2.3-beta.0")).toBe(1);
		expect(compareSemver("1.2.3-beta.0", "1.2.3-beta.1")).toBe(-1);
	});

	test("equal pre-release versions return 0", () => {
		expect(compareSemver("1.2.3-beta.0", "1.2.3-beta.0")).toBe(0);
	});

	test("alpha < beta alphabetically", () => {
		expect(compareSemver("1.0.0-alpha", "1.0.0-beta")).toBe(-1);
		expect(compareSemver("1.0.0-beta", "1.0.0-alpha")).toBe(1);
	});

	test("numeric id has lower precedence than alphanumeric per semver spec", () => {
		// "1.0.0-1" < "1.0.0-alpha" because numeric < alphanumeric
		expect(compareSemver("1.0.0-1", "1.0.0-alpha")).toBe(-1);
		expect(compareSemver("1.0.0-alpha", "1.0.0-1")).toBe(1);
	});

	test("longer pre-release wins over shorter when equal so far", () => {
		expect(compareSemver("1.0.0-alpha.1", "1.0.0-alpha")).toBe(1);
		expect(compareSemver("1.0.0-alpha", "1.0.0-alpha.1")).toBe(-1);
	});

	test("handles v-prefix gracefully (treats as non-numeric)", () => {
		// not semver, but shouldn't crash
		expect(() => compareSemver("v1.0.0", "v1.0.0")).not.toThrow();
	});
});
