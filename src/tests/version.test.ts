import { describe, expect, test } from "bun:test";
import { bumpBeta, bumpVersion } from "../steps/version.ts";

describe("bumpVersion", () => {
	test("patch increment", () => {
		expect(bumpVersion("1.2.3", "patch")).toBe("1.2.4");
	});

	test("minor increment resets patch", () => {
		expect(bumpVersion("1.2.3", "minor")).toBe("1.3.0");
	});

	test("major increment resets minor and patch", () => {
		expect(bumpVersion("1.2.3", "major")).toBe("2.0.0");
	});

	test("strips pre-release suffix before bumping", () => {
		expect(bumpVersion("1.2.3-beta.5", "patch")).toBe("1.2.4");
		expect(bumpVersion("1.2.3-beta.5", "minor")).toBe("1.3.0");
		expect(bumpVersion("1.2.3-beta.5", "major")).toBe("2.0.0");
	});

	test("patch from 0.0.0", () => {
		expect(bumpVersion("0.0.0", "patch")).toBe("0.0.1");
	});
});

describe("bumpBeta", () => {
	test("stable → beta.0 on patch", () => {
		expect(bumpBeta("1.2.3", "patch")).toBe("1.2.4-beta.0");
	});

	test("stable → minor beta.0", () => {
		expect(bumpBeta("1.2.3", "minor")).toBe("1.3.0-beta.0");
	});

	test("stable → major beta.0", () => {
		expect(bumpBeta("1.2.3", "major")).toBe("2.0.0-beta.0");
	});

	test("existing beta increments N", () => {
		expect(bumpBeta("1.2.3-beta.0", "patch")).toBe("1.2.3-beta.1");
		expect(bumpBeta("1.2.3-beta.4", "patch")).toBe("1.2.3-beta.5");
	});

	test("existing beta ignores bumpType (just increments N)", () => {
		// When already in beta, bumpBeta ignores the type arg and increments
		expect(bumpBeta("1.2.3-beta.2", "major")).toBe("1.2.3-beta.3");
	});
});
