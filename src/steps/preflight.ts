import * as p from "@clack/prompts";
import pc from "picocolors";
import type { ResolvedConfig } from "../types.ts";
import { exec } from "../utils.ts";

export function runPreflight(config: ResolvedConfig, isBeta: boolean): string {
	const spinner = p.spinner();
	spinner.start("Running preflight checks");

	const status = exec("git", ["status", "--porcelain"], { cwd: config.root }).trim();
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
