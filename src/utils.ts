import { execFile, execFileSync, execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

export function exec(
	file: string,
	args: string[],
	opts?: { cwd?: string; stdio?: "inherit" | "pipe" },
): string {
	return execFileSync(file, args, {
		cwd: opts?.cwd,
		stdio: opts?.stdio ?? "pipe",
		encoding: "utf-8",
	}) as string;
}

export function shell(
	cmd: string,
	opts?: { cwd?: string; stdio?: "inherit" | "pipe" },
): string {
	return execSync(cmd, {
		cwd: opts?.cwd,
		stdio: opts?.stdio ?? "pipe",
		encoding: "utf-8",
	}) as string;
}

export function readJson(path: string): Record<string, unknown> {
	return JSON.parse(readFileSync(path, "utf-8"));
}

export function writeJson(path: string, data: Record<string, unknown>): void {
	writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
}

export function detectDefaultBranch(dir: string): string {
	try {
		const ref = exec("git", ["symbolic-ref", "refs/remotes/origin/HEAD"], { cwd: dir }).trim();
		const match = ref.match(/refs\/remotes\/origin\/(.+)/);
		if (match) return match[1];
	} catch {
		// no remote or HEAD not set
	}

	try {
		const branches = exec("git", ["branch", "--list", "main", "master"], { cwd: dir }).trim();
		const list = branches.split("\n").map((b) => b.replace(/^\*?\s+/, "").trim()).filter(Boolean);
		if (list.includes("main")) return "main";
		if (list.includes("master")) return "master";
	} catch {
		// not a git repo
	}

	return "main";
}

export function branchExists(dir: string, branch: string): boolean {
	try {
		exec("git", ["rev-parse", "--verify", branch], { cwd: dir });
		return true;
	} catch {
		return false;
	}
}

export function getGithubSlug(dir: string): string | null {
	try {
		const remote = exec("git", ["remote", "get-url", "origin"], { cwd: dir }).trim();
		const match = remote.match(/github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/);
		if (match) return `${match[1]}/${match[2]}`;
		return null;
	} catch {
		return null;
	}
}

/**
 * Returns true if the repo's GitHub remote is archived, false if not, null if undetectable
 * (no GitHub remote, `gh` not installed, not authenticated, repo not found, etc).
 * Callers should treat `null` as "can't tell — proceed" rather than a hard failure.
 */
export function isRepoArchived(dir: string): boolean | null {
	const slug = getGithubSlug(dir);
	if (!slug) return null;
	try {
		const output = exec("gh", ["repo", "view", slug, "--json", "isArchived"], { cwd: dir });
		const data = JSON.parse(output) as { isArchived?: boolean };
		return data.isArchived === true;
	} catch {
		return null;
	}
}

export function checkArchivedBatch(
	dirs: string[],
): Promise<Map<string, boolean>> {
	const slugsByDir = new Map<string, string>();
	for (const dir of dirs) {
		const slug = getGithubSlug(dir);
		if (slug) slugsByDir.set(dir, slug);
	}

	if (slugsByDir.size === 0) return Promise.resolve(new Map());

	const entries = [...slugsByDir.entries()];
	const aliases: string[] = [];
	for (let i = 0; i < entries.length; i++) {
		const [, slug] = entries[i];
		const [owner, name] = slug.split("/");
		aliases.push(`r${i}: repository(owner: "${owner}", name: "${name}") { isArchived }`);
	}

	const query = `query { ${aliases.join(" ")} }`;

	return new Promise((resolve) => {
		execFile("gh", ["api", "graphql", "-f", `query=${query}`], (err, stdout) => {
			const result = new Map<string, boolean>();
			const raw = stdout || (err as { stdout?: string } | null)?.stdout || "";
			if (!raw) { resolve(result); return; }
			try {
				const parsed = JSON.parse(raw) as { data?: Record<string, { isArchived?: boolean } | null> };
				if (!parsed.data) { resolve(result); return; }
				for (let i = 0; i < entries.length; i++) {
					const repo = parsed.data[`r${i}`];
					if (repo) result.set(entries[i][0], repo.isArchived === true);
				}
			} catch {
				// parse failed
			}
			resolve(result);
		});
	});
}

export function isGitRepo(dir: string): boolean {
	try {
		execFileSync("git", ["rev-parse", "--git-dir"], {
			cwd: dir,
			stdio: "pipe",
			encoding: "utf-8",
		});
		return true;
	} catch {
		return false;
	}
}

export function setupCleanExit(): void {
	process.on("SIGINT", () => {
		process.stdout.write("\x1B[?25h\n");
		process.exit(130);
	});
}

export function errorText(err: unknown): string {
	if (err instanceof Error) {
		if ("stderr" in err && typeof err.stderr === "string" && err.stderr.trim())
			return err.stderr.trim();
		return err.message;
	}
	return String(err);
}

export function parseFlag(argv: string[], flag: string): string | undefined {
	const idx = argv.indexOf(flag);
	if (idx === -1 || idx === argv.length - 1) return undefined;
	const next = argv[idx + 1];
	if (next.startsWith("--")) return undefined;
	return next;
}
