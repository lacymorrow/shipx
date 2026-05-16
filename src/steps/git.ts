import * as p from "@clack/prompts";
import pc from "picocolors";
import type { ResolvedConfig } from "../types.ts";
import { exec, errorText } from "../utils.ts";

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

function isRemoteAhead(err: unknown): boolean {
	const msg = errorText(err);
	return msg.includes("fetch first") || msg.includes("non-fast-forward");
}

export async function pushChanges(
	config: ResolvedConfig,
	branch: string,
	tag: string,
	newVersion: string,
): Promise<void> {
	const spinner = p.spinner();
	spinner.start("Pushing to GitHub");

	try {
		exec(
			"git",
			["push", "origin", branch, ...splitFlags(config.git.pushFlags)],
			{ cwd: config.root },
		);
	} catch (err) {
		if (!isRemoteAhead(err)) throw err;

		spinner.stop(pc.yellow("Remote has new commits"));
		const pull = await p.confirm({
			message: `Remote is ahead of local. Pull (rebase) and retry push?`,
		});
		if (p.isCancel(pull) || !pull) {
			p.log.error("Push aborted — remote is ahead. Run " + pc.green("git pull --rebase") + " manually.");
			process.exit(1);
		}

		const pullSpinner = p.spinner();
		pullSpinner.start("Pulling with rebase");
		exec("git", ["pull", "--rebase", "origin", branch], { cwd: config.root });
		pullSpinner.stop("Pulled successfully");

		const retrySpinner = p.spinner();
		retrySpinner.start("Retrying push");
		exec(
			"git",
			["push", "origin", branch, ...splitFlags(config.git.pushFlags)],
			{ cwd: config.root },
		);
		retrySpinner.stop("Pushed branch");

		const tagSpinner = p.spinner();
		tagSpinner.start("Pushing tags");
		exec("git", ["push", "origin", tag], { cwd: config.root });

		const extraTags = resolveExtraTags(config, tag, newVersion);
		for (const extraTag of extraTags) {
			exec("git", ["push", "origin", extraTag], { cwd: config.root });
		}
		tagSpinner.stop("Pushed to GitHub");
		return;
	}

	exec("git", ["push", "origin", tag], { cwd: config.root });

	const extraTags = resolveExtraTags(config, tag, newVersion);
	for (const extraTag of extraTags) {
		exec("git", ["push", "origin", extraTag], { cwd: config.root });
	}

	spinner.stop("Pushed to GitHub");
}
