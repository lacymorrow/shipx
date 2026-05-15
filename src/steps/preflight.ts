import * as p from "@clack/prompts";
import pc from "picocolors";
import type { ResolvedConfig } from "../types.ts";
import { exec } from "../utils.ts";

export function runPreflight(config: ResolvedConfig, isBeta: boolean): string {
	const spinner = p.spinner();
	spinner.start("Running preflight checks");

	let status: string;
	try {
		status = exec("git", ["status", "--porcelain"], { cwd: config.root }).trim();
	} catch {
		spinner.stop(pc.red("Not a git repository"));
		p.log.error(
			`${pc.cyan(config.root)} is not a git repository.\n` +
			`  Run ${pc.green("shipx")} from inside a project, or use ${pc.green("shipx --multi")} to deploy multiple projects.`,
		);
		process.exit(1);
	}
	if (status) {
		spinner.stop(pc.red("Working tree is not clean"));
		p.log.error("Commit or stash changes first:");
		console.log(pc.dim(status));
		process.exit(1);
	}

	const branch = exec("git", ["branch", "--show-current"], { cwd: config.root }).trim();
	if (!isBeta && branch !== config.git.releaseBranch) {
		spinner.stop(
			pc.red(`On branch '${branch}', not '${config.git.releaseBranch}'`),
		);
		process.exit(1);
	}

	spinner.stop("Preflight OK");
	return branch;
}
