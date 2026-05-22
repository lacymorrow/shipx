import { describe, expect, test } from "bun:test";
import { parseFlag } from "../utils.ts";

describe("parseFlag", () => {
	test("returns the value after the flag", () => {
		expect(parseFlag(["--tag", "next"], "--tag")).toBe("next");
	});

	test("flag not present returns undefined", () => {
		expect(parseFlag(["--beta"], "--tag")).toBeUndefined();
	});

	test("flag at end with no value returns undefined", () => {
		expect(parseFlag(["--tag"], "--tag")).toBeUndefined();
	});

	test("empty argv returns undefined", () => {
		expect(parseFlag([], "--tag")).toBeUndefined();
	});

	test("rejects flag-shaped value (next arg starts with --)", () => {
		expect(parseFlag(["--tag", "--beta"], "--tag")).toBeUndefined();
	});

	test("rejects flag-shaped value in middle of argv", () => {
		expect(parseFlag(["--dry-run", "--tag", "--no-tests", "patch"], "--tag")).toBeUndefined();
	});
});
