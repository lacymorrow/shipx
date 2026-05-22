import { describe, expect, test } from "bun:test";
import { normalizeFlags } from "./config.ts";

describe("normalizeFlags (M2)", () => {
	test("undefined → empty array", () => {
		expect(normalizeFlags(undefined)).toEqual([]);
	});

	test("passes through an array unchanged", () => {
		expect(normalizeFlags(["--no-verify"])).toEqual(["--no-verify"]);
		expect(normalizeFlags(["--force-with-lease", "--no-verify"])).toEqual([
			"--force-with-lease",
			"--no-verify",
		]);
	});

	test("preserves array entries containing spaces verbatim", () => {
		// This is exactly what whitespace-splitting a string breaks.
		expect(normalizeFlags(["-m", "release: v1"])).toEqual(["-m", "release: v1"]);
	});

	test("strings split on whitespace (backward compat with old config form)", () => {
		expect(normalizeFlags("--no-verify")).toEqual(["--no-verify"]);
		expect(normalizeFlags("--force-with-lease --no-verify")).toEqual([
			"--force-with-lease",
			"--no-verify",
		]);
	});

	test("string form drops empty tokens from extra whitespace", () => {
		expect(normalizeFlags("  --no-verify   --no-gpg-sign  ")).toEqual([
			"--no-verify",
			"--no-gpg-sign",
		]);
	});

	test("array form drops empty-string entries", () => {
		expect(normalizeFlags(["", "--no-verify", ""])).toEqual(["--no-verify"]);
	});
});
