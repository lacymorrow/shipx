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

	try {
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
	} catch (err) {
		spinner.stop(pc.red("Commit/tag failed"));
		throw err;
	}
}

function isRemoteAhead(err: unknown): boolean {
	const msg = errorText(err);
	return msg.includes("fetch first") || msg.includes("non-fast-forward");
}

function hasDirtyTree(cwd: string): boolean {
	try {
		const out = exec("git", ["status", "--porcelain"], { cwd }).trim();
		return out.length > 0;
	} catch {
		return false;
	}
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
		if (!isRemoteAhead(err)) {
			spinner.stop(pc.red("Push failed"));
			throw err;
		}

		spinner.stop(pc.yellow("Remote has new commits"));
		const pull = await p.confirm({
			message: `Remote is ahead of local. Pull (rebase) and retry push?`,
		});
		if (p.isCancel(pull) || !pull) {
			p.log.error("Push aborted — remote is ahead. Run " + pc.green("git pull --rebase") + " manually.");
			process.exit(1);
		}

		const stashMessage = `shipx: pre-pull-rebase ${tag}`;
		let stashed = false;
		if (hasDirtyTree(config.root)) {
			const stashSpinner = p.spinner();
			stashSpinner.start("Stashing dirty files before pull");
			try {
				exec(
					"git",
					["stash", "push", "--include-untracked", "-m", stashMessage],
					{ cwd: config.root },
				);
				stashed = true;
				stashSpinner.stop("Stashed dirty files");
			} catch (stashErr) {
				stashSpinner.stop(pc.red("Stash failed"));
				throw stashErr;
			}
		}

		const pullSpinner = p.spinner();
		pullSpinner.start("Pulling with rebase");
		try {
			exec("git", ["pull", "--rebase", "origin", branch], { cwd: config.root });
			pullSpinner.stop("Pulled successfully");
		} catch (pullErr) {
			pullSpinner.stop(pc.red("Pull failed"));
			if (stashed) {
				p.log.warn(
					`Dirty files remain stashed as ${pc.cyan(stashMessage)}. Recover with ${pc.green("git stash pop")}.`,
				);
			}
			throw pullErr;
		}

		if (stashed) {
			const popSpinner = p.spinner();
			popSpinner.start("Restoring stashed files");
			try {
				exec("git", ["stash", "pop"], { cwd: config.root });
				popSpinner.stop("Restored stashed files");
			} catch (popErr) {
				popSpinner.stop(pc.red("Stash pop failed"));
				p.log.error(
					`Stash pop failed — likely a conflict. Resolve manually: ${pc.green("git stash list")} then ${pc.green("git stash pop")}.`,
				);
				throw popErr;
			}
		}

		const retrySpinner = p.spinner();
		retrySpinner.start("Retrying push");
		try {
			exec(
				"git",
				["push", "origin", branch, ...splitFlags(config.git.pushFlags)],
				{ cwd: config.root },
			);
			retrySpinner.stop("Pushed branch");
		} catch (retryErr) {
			retrySpinner.stop(pc.red("Retry push failed"));
			throw retryErr;
		}

		const tagSpinner = p.spinner();
		tagSpinner.start("Pushing tags");
		try {
			exec("git", ["push", "origin", tag], { cwd: config.root });

			const extraTags = resolveExtraTags(config, tag, newVersion);
			for (const extraTag of extraTags) {
				exec("git", ["push", "origin", extraTag], { cwd: config.root });
			}
			tagSpinner.stop("Pushed to GitHub");
		} catch (tagErr) {
			tagSpinner.stop(pc.red("Tag push failed"));
			throw tagErr;
		}
		return;
	}

	try {
		exec("git", ["push", "origin", tag], { cwd: config.root });

		const extraTags = resolveExtraTags(config, tag, newVersion);
		for (const extraTag of extraTags) {
			exec("git", ["push", "origin", extraTag], { cwd: config.root });
		}
	} catch (tagErr) {
		spinner.stop(pc.red("Tag push failed"));
		throw tagErr;
	}

	spinner.stop("Pushed to GitHub");
}
