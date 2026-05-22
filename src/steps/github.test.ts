import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveGlobs } from "./github.ts";

describe("resolveGlobs", () => {
	test("matches files with wildcard pattern", () => {
		const dir = mkdtempSync(join(tmpdir(), "shipx-globs-"));
		try {
			mkdirSync(join(dir, "dist"));
			writeFileSync(join(dir, "dist", "app.zip"), "");
			writeFileSync(join(dir, "dist", "app.tar.gz"), "");
			writeFileSync(join(dir, "dist", "README.md"), "");

			const result = resolveGlobs(dir, ["dist/*.zip"]);
			expect(result).toEqual([join(dir, "dist", "app.zip")]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("returns empty array when no files match", () => {
		const dir = mkdtempSync(join(tmpdir(), "shipx-globs-"));
		try {
			mkdirSync(join(dir, "dist"));
			writeFileSync(join(dir, "dist", "app.txt"), "");

			const result = resolveGlobs(dir, ["dist/*.zip"]);
			expect(result).toEqual([]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("returns empty array when directory does not exist", () => {
		const dir = mkdtempSync(join(tmpdir(), "shipx-globs-"));
		try {
			const result = resolveGlobs(dir, ["nonexistent/*.zip"]);
			expect(result).toEqual([]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("deduplicates files matched by multiple patterns", () => {
		const dir = mkdtempSync(join(tmpdir(), "shipx-globs-"));
		try {
			mkdirSync(join(dir, "dist"));
			writeFileSync(join(dir, "dist", "app.zip"), "");

			const result = resolveGlobs(dir, ["dist/*.zip", "dist/*.zip"]);
			expect(result).toEqual([join(dir, "dist", "app.zip")]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("combines results from multiple patterns", () => {
		const dir = mkdtempSync(join(tmpdir(), "shipx-globs-"));
		try {
			mkdirSync(join(dir, "dist"));
			writeFileSync(join(dir, "dist", "app.zip"), "");
			writeFileSync(join(dir, "dist", "app.tar.gz"), "");

			const result = resolveGlobs(dir, ["dist/*.zip", "dist/*.tar.gz"]);
			expect(result).toEqual([
				join(dir, "dist", "app.tar.gz"),
				join(dir, "dist", "app.zip"),
			]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("returns sorted results", () => {
		const dir = mkdtempSync(join(tmpdir(), "shipx-globs-"));
		try {
			mkdirSync(join(dir, "dist"));
			writeFileSync(join(dir, "dist", "charlie.zip"), "");
			writeFileSync(join(dir, "dist", "alpha.zip"), "");
			writeFileSync(join(dir, "dist", "bravo.zip"), "");

			const result = resolveGlobs(dir, ["dist/*.zip"]);
			expect(result).toEqual([
				join(dir, "dist", "alpha.zip"),
				join(dir, "dist", "bravo.zip"),
				join(dir, "dist", "charlie.zip"),
			]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
