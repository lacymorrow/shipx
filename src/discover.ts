import { execFile, execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import { readJson } from "./utils.ts";

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

interface GitMeta {
	isGitRepo: boolean;
	lastTag: string;
	changeCount: number;
	branch: string;
	dirty: boolean;
	slug: string | null;
}

const GIT_META_SCRIPT = `
git rev-parse --git-dir >/dev/null 2>&1 || exit 1
tag=$(git describe --tags --abbrev=0 2>/dev/null || echo "")
if [ -n "$tag" ]; then cc=$(git rev-list --count "$tag..HEAD" 2>/dev/null || echo "0")
else cc=$(git rev-list --count HEAD 2>/dev/null || echo "0"); fi
branch=$(git branch --show-current 2>/dev/null || echo "unknown")
dirty=$(git status --porcelain 2>/dev/null | head -1)
remote=$(git remote get-url origin 2>/dev/null || echo "")
printf '%s\\n%s\\n%s\\n%s\\n%s\\n' "$tag" "$cc" "$branch" "$dirty" "$remote"
`;

function collectGitMeta(dir: string): Promise<GitMeta> {
	return new Promise((res) => {
		execFile("sh", ["-c", GIT_META_SCRIPT], { cwd: dir, encoding: "utf-8", timeout: 10_000 }, (err, stdout) => {
			if (err) {
				res({ isGitRepo: false, lastTag: "", changeCount: 0, branch: "unknown", dirty: false, slug: null });
				return;
			}
			const lines = stdout.split("\n");
			const remoteUrl = (lines[4] ?? "").trim();
			let slug: string | null = null;
			const match = remoteUrl.match(/github\.com[:/]([^/]+)\/([^/.]+)/);
			if (match) slug = `${match[1]}/${match[2]}`;

			res({
				isGitRepo: true,
				lastTag: (lines[0] ?? "").trim(),
				changeCount: parseInt((lines[1] ?? "0").trim(), 10) || 0,
				branch: (lines[2] ?? "unknown").trim() || "unknown",
				dirty: (lines[3] ?? "").trim().length > 0,
				slug,
			});
		});
	});
}

async function parallel<T>(fns: (() => Promise<T>)[], limit: number): Promise<T[]> {
	const results: T[] = new Array(fns.length);
	let next = 0;
	async function worker() {
		while (next < fns.length) {
			const idx = next++;
			results[idx] = await fns[idx]();
		}
	}
	await Promise.all(Array.from({ length: Math.min(limit, fns.length) }, () => worker()));
	return results;
}

function checkArchivedBatch(slugsByIndex: Map<number, string>): Map<number, boolean> {
	const results = new Map<number, boolean>();
	if (slugsByIndex.size === 0) return results;

	const slugs = [...slugsByIndex.values()];
	try {
		const output = execFileSync(
			"gh",
			["api", "graphql", "-f", `query=${buildArchivedQuery(slugs)}`],
			{ encoding: "utf-8", stdio: "pipe", timeout: 15_000 },
		);
		const data = JSON.parse(output) as { data?: Record<string, { isArchived?: boolean } | null> };
		if (!data.data) return results;

		let i = 0;
		for (const [idx] of slugsByIndex) {
			const node = data.data[`r${i}`];
			results.set(idx, node?.isArchived === true);
			i++;
		}
	} catch {
		// gh CLI missing, not authed, or rate-limited — treat all as non-archived
	}
	return results;
}

function buildArchivedQuery(slugs: string[]): string {
	const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, "");
	const fields = slugs.map((slug, i) => {
		const [owner, name] = slug.split("/");
		return `r${i}: repository(owner: "${safe(owner)}", name: "${safe(name)}") { isArchived }`;
	});
	return `{ ${fields.join(" ")} }`;
}

export interface DiscoverResult {
	projects: DiscoveredProject[];
	skipped: string[];
}

interface PkgCandidate {
	fullPath: string;
	dirName: string;
	name: string;
	version: string;
	isPrivate: boolean;
}

export async function discoverProjects(
	parentDir: string,
	onProgress?: (scanned: number, found: number, current: string) => void,
): Promise<DiscoverResult> {
	const entries = readdirSync(parentDir);
	const candidates: PkgCandidate[] = [];
	const skipped: string[] = [];
	let scanned = 0;

	// Phase 1: fast filesystem scan — read package.json, no subprocesses
	for (const entry of entries) {
		if (entry.startsWith(".") || entry === "node_modules") continue;

		const fullPath = resolve(parentDir, entry);
		try {
			if (!statSync(fullPath).isDirectory()) continue;
		} catch {
			continue;
		}

		scanned++;

		const pkgPath = resolve(fullPath, "package.json");
		if (!existsSync(pkgPath)) continue;

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
			fullPath,
			dirName,
			name: typeof pkg.name === "string" ? pkg.name : dirName,
			version: typeof pkg.version === "string" ? pkg.version : "0.0.0",
			isPrivate: pkg.private === true,
		});
	}

	onProgress?.(scanned, candidates.length, "collecting git info…");

	// Phase 2: parallel git metadata collection with bounded concurrency
	const gitResults = await parallel(candidates.map((c) => () => collectGitMeta(c.fullPath)), 16);

	const projects: DiscoveredProject[] = [];
	const projectSlugs: (string | null)[] = [];
	for (let i = 0; i < candidates.length; i++) {
		const c = candidates[i];
		const g = gitResults[i];
		if (!g.isGitRepo) continue;

		projects.push({
			name: c.name,
			dirName: c.dirName,
			path: c.fullPath,
			version: c.version,
			private: c.isPrivate,
			hasNpm: !c.isPrivate,
			changeCount: g.changeCount,
			lastTag: g.lastTag,
			branch: g.branch,
			dirty: g.dirty,
			archived: false,
		});
		projectSlugs.push(g.slug);
	}

	onProgress?.(scanned, projects.length, "checking archived status…");

	// Phase 3: single GraphQL call for archived status
	const slugsByIndex = new Map<number, string>();
	for (let i = 0; i < projects.length; i++) {
		const slug = projectSlugs[i];
		if (slug) slugsByIndex.set(i, slug);
	}
	const archivedResults = checkArchivedBatch(slugsByIndex);
	for (const [idx, isArchived] of archivedResults) {
		projects[idx].archived = isArchived;
	}

	return {
		projects: projects.sort((a, b) => a.dirName.localeCompare(b.dirName)),
		skipped,
	};
}
