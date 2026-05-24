import { existsSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { readJson } from "./utils.ts";

const SEARCH_DIRS = ["packages", "apps"];

/**
 * Returns a reason string if the package is not directly publishable to npm,
 * or null if it looks publishable.
 *
 * Unpublishable signals (any one is sufficient):
 *  - `"private": true`
 *  - `"workspaces"` field (monorepo root)
 *  - No entry-point field (`bin`, `main`, `exports`, `module`)
 */
export function isUnpublishablePackage(pkg: Record<string, unknown>): string | null {
	if (pkg.private === true) return 'marked "private": true';
	if (pkg.workspaces) return 'workspace root (has "workspaces" field)';
	const hasEntry = pkg.bin || pkg.main || pkg.exports || pkg.module;
	if (!hasEntry) return "no bin/main/exports/module entry point";
	return null;
}

export interface PublishTargetCandidate {
	/** Absolute path */
	cwd: string;
	/** Path relative to the root that triggered detection, for display */
	relativePath: string;
	/** Why this candidate was picked, for logging */
	reason: string;
}

interface DetectResult {
	target: PublishTargetCandidate | null;
	/** When target is null, why detection didn't fire (or did but failed) */
	reason: string;
	/** When detection found multiple candidates, list them so callers can guide the user */
	ambiguousCandidates?: PublishTargetCandidate[];
}

/**
 * If `root/package.json` is unpublishable, scan well-known subdirs
 * (`packages/*`, `apps/*`) for exactly one publishable subpackage.
 *
 * Returns:
 *  - `target` set if root is unpublishable AND exactly one candidate found.
 *  - `target` null + `ambiguousCandidates` populated if 2+ candidates found.
 *  - `target` null otherwise (root is publishable, or no candidates found).
 */
export function detectPublishTarget(root: string): DetectResult {
	const rootPkgPath = resolve(root, "package.json");
	if (!existsSync(rootPkgPath)) {
		return { target: null, reason: "no root package.json" };
	}

	let rootPkg: Record<string, unknown>;
	try {
		rootPkg = readJson(rootPkgPath);
	} catch {
		return { target: null, reason: "root package.json unreadable" };
	}

	const rootUnpublishable = isUnpublishablePackage(rootPkg);
	if (!rootUnpublishable) {
		return { target: null, reason: "root looks publishable" };
	}

	const candidates: PublishTargetCandidate[] = [];

	for (const searchDir of SEARCH_DIRS) {
		const dirPath = resolve(root, searchDir);
		if (!existsSync(dirPath)) continue;
		let entries: string[];
		try {
			entries = readdirSync(dirPath);
		} catch {
			continue;
		}

		for (const entry of entries) {
			if (entry.startsWith(".")) continue;
			const subDir = resolve(dirPath, entry);
			try {
				if (!statSync(subDir).isDirectory()) continue;
			} catch {
				continue;
			}
			const subPkgPath = resolve(subDir, "package.json");
			if (!existsSync(subPkgPath)) continue;
			let subPkg: Record<string, unknown>;
			try {
				subPkg = readJson(subPkgPath);
			} catch {
				continue;
			}
			if (isUnpublishablePackage(subPkg)) continue;
			candidates.push({
				cwd: subDir,
				relativePath: `${searchDir}/${entry}`,
				reason: `root is ${rootUnpublishable}; ${searchDir}/${entry} is the only publishable subpackage`,
			});
		}
	}

	if (candidates.length === 1) {
		return { target: candidates[0], reason: candidates[0].reason };
	}
	if (candidates.length === 0) {
		return {
			target: null,
			reason: `root is ${rootUnpublishable} and no publishable subpackage found under ${SEARCH_DIRS.join("/, ")}/`,
		};
	}
	return {
		target: null,
		reason: `root is ${rootUnpublishable} and ${candidates.length} publishable subpackages found — set npm.cwd or npm.targets explicitly`,
		ambiguousCandidates: candidates,
	};
}
