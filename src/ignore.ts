import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export function loadIgnored(root: string): Set<string> {
	const ignorePath = resolve(root, ".shipxignore");
	if (!existsSync(ignorePath)) return new Set();
	return new Set(
		readFileSync(ignorePath, "utf-8")
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line && !line.startsWith("#")),
	);
}

export function saveIgnored(root: string, ignored: Set<string>): void {
	const ignorePath = resolve(root, ".shipxignore");
	const content = [...ignored].sort().join("\n") + "\n";
	writeFileSync(ignorePath, content);
}

/**
 * Compute the new .shipxignore set after a multi-project selection prompt.
 *
 * Only persists the delta the user explicitly made:
 *   - Pre-selected projects the user deselected are added.
 *   - Anything the user selected is removed (un-ignores previously ignored entries).
 *   - Everything else in previousIgnored is preserved untouched — including
 *     ignored projects that weren't shown in this run (archived, missing, etc.).
 *
 * Projects that were never pre-selected and never selected (e.g. clean
 * projects with no changes that the user simply didn't surface) are NOT
 * added to ignored — that was the LAC-2017 bug.
 */
export function computeIgnoredAfterSelection(opts: {
	previousIgnored: Set<string>;
	preSelectedDirNames: Set<string>;
	selectedDirNames: Set<string>;
}): Set<string> {
	const result = new Set(opts.previousIgnored);
	for (const name of opts.preSelectedDirNames) {
		if (!opts.selectedDirNames.has(name)) {
			result.add(name);
		}
	}
	for (const name of opts.selectedDirNames) {
		result.delete(name);
	}
	return result;
}
