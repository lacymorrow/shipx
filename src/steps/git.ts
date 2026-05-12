import * as p from "@clack/prompts";
import pc from "picocolors";
import type { ResolvedConfig } from "../types.ts";
import { exec } from "../utils.ts";

function resolveExtraTags(config: ResolvedConfig, tag: string, newVersion: string): string[] {
	const tags = config.git.extraTags.map((tpl) =>
		tpl.replace(/\{tag\}/g, tag).replace(/\{version\}/g, newVersion),
	);
	return [...new Set(tags)].filter((t) => t !== tag);
}

function splitFlags(flags: string): string[] {
	return flags.split(/\s+/).filter(Boolean);
}

export function commitAndTag(
	config: ResolvedConfig,
	tag: string,
	newVersion: string,
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

	const extraTags = resolveExtraTags(config, tag, newVersion);
	for (const extraTag of extraTags) {
		exec("git", ["tag", extraTag], { cwd: config.root });
	}

	const allTags = [tag, ...extraTags].map((t) => pc.green(t)).join(", ");
	spinner.stop(`Committed and tagged ${allTags}`);
}

export function pushChanges(
	config: ResolvedConfig,
	branch: string,
	tag: string,
	newVersion: string,
): void {
	const spinner = p.spinner();
	spinner.start("Pushing to GitHub");

	exec(
		"git",
		["push", "origin", branch, ...splitFlags(config.git.pushFlags)],
		{ cwd: config.root },
	);
	exec("git", ["push", "origin", tag], { cwd: config.root });

	const extraTags = resolveExtraTags(config, tag, newVersion);
	for (const extraTag of extraTags) {
		exec("git", ["push", "origin", extraTag], { cwd: config.root });
	}

	spinner.stop("Pushed to GitHub");
}
