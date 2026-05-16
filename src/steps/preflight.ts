import * as p from "@clack/prompts";
import pc from "picocolors";
import type { ResolvedConfig } from "../types.ts";
import { exec } from "../utils.ts";

export async function runPreflight(config: ResolvedConfig, isBeta: boolean): Promise<string> {
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

	let branch = exec("git", ["branch", "--show-current"], { cwd: config.root }).trim();
	if (!isBeta && branch !== config.git.releaseBranch) {
		spinner.stop(
			pc.yellow(`On branch '${branch}', not '${config.git.releaseBranch}'`),
		);

		const branchAction = await p.select({
			message: `You're on '${pc.yellow(branch)}', not '${config.git.releaseBranch}'.`,
			options: [
				{ value: "switch" as const, label: `Switch to ${config.git.releaseBranch}`, hint: `git checkout ${config.git.releaseBranch}` },
				{ value: "use" as const, label: `Use ${branch}`, hint: "release from current branch" },
			],
		});

		if (p.isCancel(branchAction)) {
			p.cancel("Release cancelled.");
			process.exit(0);
		}

		if (branchAction === "switch") {
			exec("git", ["checkout", config.git.releaseBranch], { cwd: config.root });
			branch = config.git.releaseBranch;
			p.log.success(`Switched to ${config.git.releaseBranch}`);
		}

		return branch;
	}

	spinner.stop("Preflight OK");
	return branch;
}
