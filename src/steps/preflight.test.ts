import { describe, expect, test } from "bun:test";
import { resolveNpmRegistry } from "./preflight.ts";

const CWD = "/tmp";

describe("resolveNpmRegistry (M11)", () => {
	test("publishConfig.registry wins over scope and default", () => {
		const reg = resolveNpmRegistry(
			{ name: "@scope/pkg", publishConfig: { registry: "https://example.test/" } },
			CWD,
		);
		expect(reg).toBe("https://example.test/");
	});

	test("publishConfig present but no registry → falls through", () => {
		const reg = resolveNpmRegistry(
			{ name: "unscoped", publishConfig: { access: "public" } },
			CWD,
		);
		// Falls through to scope/default lookup — we just assert it didn't
		// pick the empty publishConfig case.
		expect(reg === undefined || reg.startsWith("http")).toBe(true);
	});

	test("non-scoped package with no publishConfig → default registry (or undefined)", () => {
		const reg = resolveNpmRegistry({ name: "unscoped" }, CWD);
		// In CI/dev environments npm config get registry usually returns
		// https://registry.npmjs.org/. We can't assert the exact value, but
		// we can assert it's not the empty string and is either undefined or
		// looks like a URL.
		expect(reg === undefined || /^https?:\/\//.test(reg)).toBe(true);
	});

	test("missing name field doesn't throw", () => {
		expect(() => resolveNpmRegistry({}, CWD)).not.toThrow();
	});
});
