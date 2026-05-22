import { describe, expect, test } from "bun:test";
import { classifyNpmViewError, compareSemver } from "./registry.ts";

describe("classifyNpmViewError (H3)", () => {
	test("E404 → not-published", () => {
		expect(classifyNpmViewError("npm ERR! code E404\nnpm ERR! 404 Not Found")).toBe("not-published");
	});

	test("'is not in the npm registry' → not-published", () => {
		expect(
			classifyNpmViewError("npm ERR! 404 '@lacymorrow/never-published' is not in the npm registry."),
		).toBe("not-published");
	});

	test("ENOTFOUND (DNS failure) → network-error", () => {
		expect(classifyNpmViewError("npm ERR! code ENOTFOUND\nnpm ERR! request to https://registry.npmjs.org failed, reason: getaddrinfo ENOTFOUND")).toBe(
			"network-error",
		);
	});

	test("ETIMEDOUT → network-error", () => {
		expect(classifyNpmViewError("npm ERR! network request to https://registry.npmjs.org/foo failed, reason: connect ETIMEDOUT 1.2.3.4:443")).toBe(
			"network-error",
		);
	});

	test("ECONNREFUSED → network-error", () => {
		expect(classifyNpmViewError("npm ERR! code ECONNREFUSED")).toBe("network-error");
	});

	test("empty stderr → network-error (fail loud rather than assume 404)", () => {
		expect(classifyNpmViewError("")).toBe("network-error");
	});
});

describe("compareSemver (regression)", () => {
	test("comparing two stable versions", () => {
		expect(compareSemver("1.2.3", "1.2.4")).toBe(-1);
		expect(compareSemver("1.2.3", "1.2.3")).toBe(0);
		expect(compareSemver("2.0.0", "1.99.99")).toBe(1);
	});

	test("prerelease ranks below stable", () => {
		expect(compareSemver("1.0.0", "1.0.0-beta.1")).toBe(1);
	});
});
