import { execFile } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import { checkArchivedBatch, readJson } from "./utils.ts";

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
	archived: boolean;
}

interface Candidate {
	dirName: string;
	path: string;
	name: string;
	version: string;
	isPrivate: boolean;
}

interface GitInfo {
	lastTag: string;
	changeCount: number;
	branch: string;
	dirty: boolean;
}

const GIT_INFO_SCRIPT = [
	'tag=$(git describe --tags --abbrev=0 2>/dev/null || echo "")',
	'if [ -n "$tag" ]; then count=$(git rev-list --count "$tag..HEAD" 2>/dev/null || echo "0"); else count=$(git rev-list --count HEAD 2>/dev/null || echo "0"); fi',
	'branch=$(git branch --show-current 2>/dev/null || echo "unknown")',
	'dirty=$(git status --porcelain 2>/dev/null | head -1)',
	'printf "%s\\n%s\\n%s\\n%s" "$tag" "$count" "$branch" "$dirty"',
].join("; ");

function getGitInfoAsync(dir: string): Promise<GitInfo> {
	return new Promise((resolve) => {
		execFile("sh", ["-c", GIT_INFO_SCRIPT], { cwd: dir, encoding: "utf-8" }, (err, stdout) => {
			if (err) {
				resolve({ lastTag: "", changeCount: 0, branch: "unknown", dirty: true });
				return;
			}
			const lines = (stdout as string).split("\n");
			resolve({
				lastTag: lines[0] ?? "",
				changeCount: parseInt(lines[1] ?? "0", 10) || 0,
				branch: lines[2]?.trim() || "unknown",
				dirty: (lines[3] ?? "").length > 0,
			});
		});
	});
}

function tick(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

export interface DiscoverResult {
	projects: DiscoveredProject[];
	skipped: string[];
}

export async function discoverProjects(
	parentDir: string,
	onProgress?: (scanned: number, found: number, current: string) => void,
): Promise<DiscoverResult> {
	const entries = readdirSync(parentDir);
	const candidates: Candidate[] = [];
	const skipped: string[] = [];
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
		onProgress?.(scanned, candidates.length, entry);
		await tick();

		const pkgPath = resolve(fullPath, "package.json");
		if (!existsSync(pkgPath)) continue;
		if (!existsSync(resolve(fullPath, ".git"))) continue;

		let pkg: Record<string, unknown>;
		try {
			pkg = readJson(pkgPath);
			if (!pkg || typeof pkg !== "object") {
				throw new Error();
			}
		} catch {
			skipped.push(entry);
			continue;
		}

		const dirName = basename(fullPath);
		candidates.push({
			dirName,
			path: fullPath,
			name: typeof pkg.name === "string" ? pkg.name : dirName,
			version: typeof pkg.version === "string" ? pkg.version : "0.0.0",
			isPrivate: pkg.private === true,
		});
	}

	const allDirs = candidates.map((c) => c.path);
	const [gitInfos, archivedMap] = await Promise.all([
		Promise.all(candidates.map((c) => getGitInfoAsync(c.path))),
		checkArchivedBatch(allDirs),
	]);

	const projects: DiscoveredProject[] = candidates.map((c, i) => ({
		name: c.name,
		dirName: c.dirName,
		path: c.path,
		version: c.version,
		private: c.isPrivate,
		hasNpm: !c.isPrivate,
		changeCount: gitInfos[i].changeCount,
		lastTag: gitInfos[i].lastTag,
		branch: gitInfos[i].branch,
		dirty: gitInfos[i].dirty,
		archived: archivedMap.get(c.path) === true,
	}));

	return {
		projects: projects.sort((a, b) => a.dirName.localeCompare(b.dirName)),
		skipped,
	};
}
