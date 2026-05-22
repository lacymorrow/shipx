import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeIgnoredAfterSelection, loadIgnored, saveIgnored } from "./ignore.ts";

describe("computeIgnoredAfterSelection", () => {
	test("LAC-2017 regression: accepting default selection does NOT add unselected projects to ignore", () => {
		// Repro: user runs `shipx --multi`, sees three projects with changes pre-selected,
		// and several clean projects not pre-selected. They accept the defaults.
		// Bug behavior: every clean (unselected) project got dumped into .shipxignore.
		const result = computeIgnoredAfterSelection({
			previousIgnored: new Set(),
			preSelectedDirNames: new Set(["a", "b", "c"]),
			selectedDirNames: new Set(["a", "b", "c"]),
		});
		expect([...result].sort()).toEqual([]);
	});

	test("deselecting a pre-selected project adds it to ignored", () => {
		const result = computeIgnoredAfterSelection({
			previousIgnored: new Set(),
			preSelectedDirNames: new Set(["a", "b", "c"]),
			selectedDirNames: new Set(["a", "c"]),
		});
		expect([...result].sort()).toEqual(["b"]);
	});

	test("selecting a previously-ignored project removes it from ignored", () => {
		const result = computeIgnoredAfterSelection({
			previousIgnored: new Set(["old-ignored"]),
			preSelectedDirNames: new Set(["a"]),
			selectedDirNames: new Set(["a", "old-ignored"]),
		});
		expect(result.has("old-ignored")).toBe(false);
		expect(result.has("a")).toBe(false);
	});

	test("preserves previously-ignored entries that weren't shown this run", () => {
		// e.g. archived or removed projects still in .shipxignore from a prior session.
		const result = computeIgnoredAfterSelection({
			previousIgnored: new Set(["archived-project", "stale-entry"]),
			preSelectedDirNames: new Set(["a"]),
			selectedDirNames: new Set(["a"]),
		});
		expect([...result].sort()).toEqual(["archived-project", "stale-entry"]);
	});

	test("combined: deselect one, un-ignore another, leave the rest alone", () => {
		const result = computeIgnoredAfterSelection({
			previousIgnored: new Set(["prev-ignored", "untouched"]),
			preSelectedDirNames: new Set(["a", "b"]),
			selectedDirNames: new Set(["a", "prev-ignored"]),
		});
		// "b" was pre-selected and deselected → added.
		// "prev-ignored" was selected → removed.
		// "untouched" stays.
		expect([...result].sort()).toEqual(["b", "untouched"]);
	});

	test("does NOT add clean (no-change) projects that the user simply didn't touch", () => {
		const result = computeIgnoredAfterSelection({
			previousIgnored: new Set(),
			preSelectedDirNames: new Set(["has-changes"]),
			selectedDirNames: new Set(["has-changes"]),
		});
		expect(result.has("clean-project-1")).toBe(false);
		expect(result.has("clean-project-2")).toBe(false);
	});
});

describe("loadIgnored / saveIgnored", () => {
	test("round-trips entries, ignoring comments and blank lines", () => {
		const dir = mkdtempSync(join(tmpdir(), "shipx-ignore-test-"));
		try {
			writeFileSync(
				join(dir, ".shipxignore"),
				"# header comment\nfoo\n\nbar\n# another\nbaz\n",
			);
			const loaded = loadIgnored(dir);
			expect([...loaded].sort()).toEqual(["bar", "baz", "foo"]);

			saveIgnored(dir, new Set(["zeta", "alpha"]));
			const written = readFileSync(join(dir, ".shipxignore"), "utf-8");
			expect(written).toBe("alpha\nzeta\n");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("loadIgnored returns empty set when file is missing", () => {
		const dir = mkdtempSync(join(tmpdir(), "shipx-ignore-test-"));
		try {
			expect(loadIgnored(dir).size).toBe(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
