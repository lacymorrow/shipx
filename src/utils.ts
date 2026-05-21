import { execFileSync, execSync } from "node:child_process";
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
		const match = remote.match(/github\.com[:/]([^/]+)\/([^/.]+)/);
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
