import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import { exec, isGitRepo, readJson } from "./utils.ts";

export interface DiscoveredProject {
	/** npm package name from package.json */
	name: string;
	/** Directory basename — unique per scan, used for display */
	dirName: string;
	path: string;
	version: string;
	private: boolean;
	hasNpm: boolean;
	changeCount: number;
	lastTag: string;
	branch: string;
	dirty: boolean;
}

function getLastTag(dir: string): string {
	try {
		return exec("git", ["describe", "--tags", "--abbrev=0"], { cwd: dir }).trim();
	} catch {
		return "";
	}
}

function getCommitsSinceTag(dir: string, tag: string): number {
	try {
		const range = tag ? `${tag}..HEAD` : "HEAD";
		const log = exec("git", ["rev-list", "--count", range], { cwd: dir }).trim();
		return parseInt(log, 10) || 0;
	} catch {
		return 0;
	}
}

function getCurrentBranch(dir: string): string {
	try {
		return exec("git", ["branch", "--show-current"], { cwd: dir }).trim();
	} catch {
		return "unknown";
	}
}

function isDirty(dir: string): boolean {
	try {
		const status = exec("git", ["status", "--porcelain"], { cwd: dir }).trim();
		return status.length > 0;
	} catch {
		return true;
	}
}

function tick(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

export async function discoverProjects(
	parentDir: string,
	onProgress?: (scanned: number, found: number, current: string) => void,
): Promise<DiscoveredProject[]> {
	const entries = readdirSync(parentDir);
	const projects: DiscoveredProject[] = [];
	let scanned = 0;

	for (const entry of entries) {
		if (entry.startsWith(".") || entry === "node_modules") continue;

		const fullPath = resolve(parentDir, entry);
		try {
			if (!statSync(fullPath).isDirectory()) continue;
		} catch {
			continue;
		}

		scanned++;
		onProgress?.(scanned, projects.length, entry);
		await tick();

		const pkgPath = resolve(fullPath, "package.json");
		if (!existsSync(pkgPath)) continue;
		if (!isGitRepo(fullPath)) continue;

		const pkg = readJson(pkgPath);
		const dirName = basename(fullPath);
		const name = (typeof pkg.name === "string" ? pkg.name : dirName);
		const version = (typeof pkg.version === "string" ? pkg.version : "0.0.0");
		const isPrivate = pkg.private === true;

		const lastTag = getLastTag(fullPath);
		const changeCount = getCommitsSinceTag(fullPath, lastTag);
		const branch = getCurrentBranch(fullPath);
		const dirty = isDirty(fullPath);

		projects.push({
			name,
			dirName,
			path: fullPath,
			version,
			private: isPrivate,
			hasNpm: !isPrivate,
			changeCount,
			lastTag,
			branch,
			dirty,
		});
	}

	return projects.sort((a, b) => b.changeCount - a.changeCount);
}
