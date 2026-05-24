import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { detectPublishTarget, isUnpublishablePackage } from "./detect.ts";

describe("isUnpublishablePackage", () => {
	test('returns reason for "private": true', () => {
		expect(isUnpublishablePackage({ private: true, bin: "x.js" })).toMatch(/private/);
	});

	test('returns reason for "workspaces" field', () => {
		expect(isUnpublishablePackage({ workspaces: ["packages/*"], bin: "x.js" })).toMatch(/workspace/);
	});

	test("returns reason when no entry-point fields are present", () => {
		expect(isUnpublishablePackage({ name: "foo" })).toMatch(/entry point/);
	});

	test("returns null when package has bin", () => {
		expect(isUnpublishablePackage({ bin: "x.js" })).toBeNull();
	});

	test("returns null when package has main", () => {
		expect(isUnpublishablePackage({ main: "index.js" })).toBeNull();
	});

	test("returns null when package has exports", () => {
		expect(isUnpublishablePackage({ exports: { ".": "./index.js" } })).toBeNull();
	});

	test("returns null when package has module", () => {
		expect(isUnpublishablePackage({ module: "index.mjs" })).toBeNull();
	});

	test("private takes precedence over having a bin", () => {
		expect(isUnpublishablePackage({ private: true, bin: "x.js" })).toMatch(/private/);
	});
});

describe("detectPublishTarget", () => {
	let root: string;

	beforeEach(() => {
		root = mkdtempSync(resolve(tmpdir(), "shipx-detect-"));
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	function writePkg(dir: string, pkg: object): void {
		mkdirSync(dir, { recursive: true });
		writeFileSync(resolve(dir, "package.json"), JSON.stringify(pkg));
	}

	test("returns null when no root package.json", () => {
		const result = detectPublishTarget(root);
		expect(result.target).toBeNull();
		expect(result.reason).toMatch(/no root package.json/);
	});

	test("returns null when root is publishable", () => {
		writePkg(root, { name: "foo", bin: "cli.js" });
		const result = detectPublishTarget(root);
		expect(result.target).toBeNull();
		expect(result.reason).toMatch(/publishable/);
	});

	test('detects single subpackage when root has "private": true', () => {
		writePkg(root, { name: "lacy", private: true });
		writePkg(resolve(root, "packages/lacy"), {
			name: "lacy",
			bin: { lacy: "index.mjs" },
		});

		const result = detectPublishTarget(root);
		expect(result.target).not.toBeNull();
		expect(result.target?.relativePath).toBe("packages/lacy");
		expect(result.target?.cwd).toBe(resolve(root, "packages/lacy"));
	});

	test('detects single subpackage when root has "workspaces"', () => {
		writePkg(root, { name: "monorepo", workspaces: ["packages/*"] });
		writePkg(resolve(root, "packages/core"), { name: "core", main: "index.js" });

		const result = detectPublishTarget(root);
		expect(result.target?.relativePath).toBe("packages/core");
	});

	test("detects subpackage when root has no entry points", () => {
		writePkg(root, { name: "monorepo" });
		writePkg(resolve(root, "apps/cli"), { name: "cli", bin: "cli.js" });

		const result = detectPublishTarget(root);
		expect(result.target?.relativePath).toBe("apps/cli");
	});

	test("returns ambiguous when multiple publishable subpackages exist", () => {
		writePkg(root, { name: "monorepo", private: true });
		writePkg(resolve(root, "packages/a"), { name: "a", main: "a.js" });
		writePkg(resolve(root, "packages/b"), { name: "b", main: "b.js" });

		const result = detectPublishTarget(root);
		expect(result.target).toBeNull();
		expect(result.ambiguousCandidates).toHaveLength(2);
		expect(result.reason).toMatch(/set npm.cwd or npm.targets explicitly/);
	});

	test("skips unpublishable subpackages when searching", () => {
		writePkg(root, { name: "monorepo", private: true });
		writePkg(resolve(root, "packages/published"), { name: "published", bin: "x.js" });
		writePkg(resolve(root, "packages/private"), { name: "private", private: true, bin: "y.js" });
		writePkg(resolve(root, "packages/empty"), { name: "empty" });

		const result = detectPublishTarget(root);
		expect(result.target?.relativePath).toBe("packages/published");
	});

	test("returns null when root is unpublishable and no subpackages found", () => {
		writePkg(root, { name: "monorepo", private: true });

		const result = detectPublishTarget(root);
		expect(result.target).toBeNull();
		expect(result.reason).toMatch(/no publishable subpackage found/);
	});

	test("searches apps/ in addition to packages/", () => {
		writePkg(root, { name: "monorepo", workspaces: ["apps/*"] });
		writePkg(resolve(root, "apps/web"), { name: "web", main: "index.js" });

		const result = detectPublishTarget(root);
		expect(result.target?.relativePath).toBe("apps/web");
	});
});
