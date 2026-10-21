import { afterEach, describe, expect, test } from "bun:test";
import { setAssumeYes } from "../interactive.ts";
import { bumpBeta, bumpVersion, pickVersion } from "./version.ts";

afterEach(() => {
	setAssumeYes(false);
});

describe("bumpVersion", () => {
	test("bumps each level from a release version", () => {
		expect(bumpVersion("1.2.3", "patch")).toBe("1.2.4");
		expect(bumpVersion("1.2.3", "minor")).toBe("1.3.0");
		expect(bumpVersion("1.2.3", "major")).toBe("2.0.0");
	});

	test("drops a pre-release suffix before bumping", () => {
		expect(bumpVersion("1.2.3-beta.7", "patch")).toBe("1.2.4");
	});
});

describe("bumpBeta", () => {
	test("increments the counter when already a beta", () => {
		expect(bumpBeta("1.2.3-beta.7", "patch")).toBe("1.2.3-beta.8");
	});

	test("starts a new beta line from a release version", () => {
		expect(bumpBeta("1.2.3", "minor")).toBe("1.3.0-beta.0");
	});
});

describe("pickVersion, unattended (#70)", () => {
	test("a named level answers the non-beta path with no prompt", async () => {
		setAssumeYes(true);
		expect(await pickVersion("1.2.3", "minor", false)).toBe("1.3.0");
	});

	test("an explicit version answers the non-beta path with no prompt", async () => {
		setAssumeYes(true);
		expect(await pickVersion("1.2.3", "2.0.0", false)).toBe("2.0.0");
	});

	test("a named level answers the beta path for a release version", async () => {
		setAssumeYes(true);
		expect(await pickVersion("1.2.3", "patch", true)).toBe("1.2.4-beta.0");
	});

	// The hole this pins: `--multi patch --beta --yes` over a project already
	// on a beta opened the "Beta bump?" select, which a named level does not
	// answer. With stdin closed the prompt rendered, nothing arrived, and the
	// run exited 0 having released nothing.
	test("a project already on a beta takes the next beta instead of prompting", async () => {
		setAssumeYes(true);
		expect(await pickVersion("1.0.0-beta.3", "patch", true)).toBe("1.0.0-beta.4");
	});

	test("the named level does not reroute an in-flight beta to a new line", async () => {
		// Interactively a named level does not answer this select either: the
		// counter bump is the prompt's own pre-selected option, so unattended
		// matches what pressing Enter would have done.
		setAssumeYes(true);
		expect(await pickVersion("1.0.0-beta.3", "major", true)).toBe("1.0.0-beta.4");
	});
});
