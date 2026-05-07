import * as p from "@clack/prompts";
import pc from "picocolors";
import type { ResolvedConfig } from "../types.ts";
import { exec } from "../utils.ts";

function splitFlags(flags: string): string[] {
	return flags.split(/\s+/).filter(Boolean);
}

export function commitAndTag(
	config: ResolvedConfig,
	tag: string,
	filesToStage: string[],
): void {
	const spinner = p.spinner();
	spinner.start("Committing and tagging");

	if (filesToStage.length > 0) {
		exec("git", ["add", ...filesToStage], { cwd: config.root });
	}

	const message = config.git.commitMessage.replace(/\{tag\}/g, tag);
	exec(
		"git",
		["commit", "-m", message, ...splitFlags(config.git.commitFlags)],
		{ cwd: config.root },
	);
	exec("git", ["tag", tag], { cwd: config.root });

	spinner.stop(`Committed and tagged ${pc.green(tag)}`);
}

export function pushChanges(
	config: ResolvedConfig,
	branch: string,
	tag: string,
): void {
	const spinner = p.spinner();
	spinner.start("Pushing to GitHub");

	exec(
		"git",
		["push", "origin", branch, ...splitFlags(config.git.pushFlags)],
		{ cwd: config.root },
	);
	exec("git", ["push", "origin", tag], { cwd: config.root });

	spinner.stop("Pushed to GitHub");
}
