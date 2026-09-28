import { afterEach, describe, expect, test } from "bun:test";
import { canAutoConfirmRelease, isNonInteractive, setAssumeYes } from "./interactive.ts";

/** stdin.isTTY is a plain property on the stream, so it can be swapped per test. */
function withTty(isTty: boolean, fn: () => void) {
	const original = process.stdin.isTTY;
	Object.defineProperty(process.stdin, "isTTY", { value: isTty, configurable: true });
	try {
		fn();
	} finally {
		Object.defineProperty(process.stdin, "isTTY", { value: original, configurable: true });
	}
}

const originalCi = process.env.CI;

afterEach(() => {
	setAssumeYes(false);
	if (originalCi === undefined) delete process.env.CI;
	else process.env.CI = originalCi;
});

/** `CI` is read as a string, so "" and "false" both have to be expressible. */
function setCi(value: string) {
	if (value === "") delete process.env.CI;
	else process.env.CI = value;
}

describe("isNonInteractive", () => {
	test("is false at a terminal with no CI marker", () => {
		setCi("");
		withTty(true, () => expect(isNonInteractive()).toBe(false));
	});

	test("is true when CI is set", () => {
		setCi("true");
		withTty(true, () => expect(isNonInteractive()).toBe(true));
	});

	test('treats CI="false" as not CI', () => {
		// Some runners export CI=false rather than leaving it unset. Taking the
		// string as truthy would silently skip confirms for anyone who does.
		setCi("false");
		withTty(true, () => expect(isNonInteractive()).toBe(false));
	});

	test("is true when stdin is not a terminal", () => {
		setCi("");
		withTty(false, () => expect(isNonInteractive()).toBe(true));
	});

	test("is true whenever --yes was passed, terminal or not", () => {
		setCi("");
		setAssumeYes(true);
		withTty(true, () => expect(isNonInteractive()).toBe(true));
	});
});

describe("canAutoConfirmRelease", () => {
	test("auto-confirms a named bump in CI", () => {
		setCi("true");
		expect(canAutoConfirmRelease(true)).toBe(true);
	});

	test("still asks in CI when the bump was not named", () => {
		// `shipx` with no argument has to guess the version. A run that guessed
		// is not one to also approve itself.
		setCi("true");
		expect(canAutoConfirmRelease(false)).toBe(false);
	});

	test("still asks at a terminal even when the bump was named", () => {
		setCi("");
		withTty(true, () => expect(canAutoConfirmRelease(true)).toBe(false));
	});

	test("--yes overrides the named-bump requirement", () => {
		// Explicit beats inferred: someone typed the flag.
		setCi("");
		setAssumeYes(true);
		withTty(true, () => expect(canAutoConfirmRelease(false)).toBe(true));
	});
});
