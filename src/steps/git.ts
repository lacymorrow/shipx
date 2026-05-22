import * as p from "@clack/prompts";
import pc from "picocolors";
import type { ResolvedConfig } from "../types.ts";
import { exec, errorText } from "../utils.ts";

export class PartialPushError extends Error {
	readonly pushedTags: string[];
	readonly branchPushed: boolean;

	constructor(message: string, pushedTags: string[], branchPushed = false) {
		super(message);
		this.name = "PartialPushError";
		this.pushedTags = pushedTags;
		this.branchPushed = branchPushed;
	}
}

export interface RollbackPlan {
	localTagsToDelete: string[];
	remoteTagsToDelete: string[];
	branchPushed: boolean;
}

export function planRollback(
	allTags: string[],
	pushedTags: string[],
	branchPushed?: boolean,
): RollbackPlan {
	const pushedSet = new Set(pushedTags);
	return {
		localTagsToDelete: allTags,
		remoteTagsToDelete: allTags.filter((t) => pushedSet.has(t)),
		branchPushed: branchPushed ?? pushedTags.length > 0,
	};
}

function resolveExtraTags(config: ResolvedConfig, tag: string, newVersion: string): string[] {
	const tags = config.git.extraTags.map((tpl) =>
		tpl.replace(/\{tag\}/g, tag).replace(/\{version\}/g, newVersion),
	);
	return [...new Set(tags)].filter((t) => t !== tag);
}

export function tagExists(cwd: string, tag: string): boolean {
	try {
		exec("git", ["rev-parse", "--verify", `refs/tags/${tag}`], { cwd });
		return true;
	} catch {
		return false;
	}
}

export function commitAndTag(
	config: ResolvedConfig,
	tag: string,
	newVersion: string,
	filesToStage: string[],
): void {
	const spinner = p.spinner();
	spinner.start("Committing and tagging");

	const allTags = [tag, ...resolveExtraTags(config, tag, newVersion)];
	const existingTags = allTags.filter((t) => tagExists(config.root, t));
	if (existingTags.length > 0) {
		spinner.stop(pc.red("Tag collision"));
		throw new Error(
			`Tag(s) already exist locally: ${existingTags.join(", ")}. ` +
			`Delete them (${`git tag -d ${existingTags.join(" ")}`}) and pick a higher version before retrying.`,
		);
	}

	try {
		if (filesToStage.length > 0) {
			exec("git", ["add", ...filesToStage], { cwd: config.root });
		}

		const message = config.git.commitMessage.replace(/\{tag\}/g, tag);
		exec(
			"git",
			["commit", "-m", message, ...config.git.commitFlags],
			{ cwd: config.root },
		);
		exec("git", ["tag", tag], { cwd: config.root });

		const extraTags = resolveExtraTags(config, tag, newVersion);
		for (const extraTag of extraTags) {
			exec("git", ["tag", extraTag], { cwd: config.root });
		}

		const tagSummary = [tag, ...extraTags].map((t) => pc.green(t)).join(", ");
		spinner.stop(`Committed and tagged ${tagSummary}`);
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

function pushTagsTracked(
	config: ResolvedConfig,
	tag: string,
	newVersion: string,
	branchPushed: boolean,
): string[] {
	const pushedTags: string[] = [];

	try {
		exec("git", ["push", "origin", tag], { cwd: config.root });
		pushedTags.push(tag);
	} catch (err) {
		throw new PartialPushError(
			errorText(err),
			pushedTags,
			branchPushed,
		);
	}

	const extraTags = resolveExtraTags(config, tag, newVersion);
	for (const extraTag of extraTags) {
		try {
			exec("git", ["push", "origin", extraTag], { cwd: config.root });
			pushedTags.push(extraTag);
		} catch (err) {
			throw new PartialPushError(
				errorText(err),
				pushedTags,
				branchPushed,
			);
		}
	}

	return pushedTags;
}

export async function pushChanges(
	config: ResolvedConfig,
	branch: string,
	tag: string,
	newVersion: string,
): Promise<string[]> {
	const spinner = p.spinner();
	spinner.start("Pushing to GitHub");

	try {
		exec(
			"git",
			["push", "origin", branch, ...config.git.pushFlags],
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
			const allLocalTags = [tag, ...resolveExtraTags(config, tag, newVersion)];
			p.log.warn(
				`Rebase conflict — the release tag(s) ${allLocalTags.map((t) => pc.cyan(t)).join(", ")} were created locally but never pushed. ` +
				`If you retry shipx, the next commit-and-tag will collide.\n` +
				`  Delete them first: ${pc.green(`git tag -d ${allLocalTags.join(" ")}`)}`,
			);
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
				["push", "origin", branch, ...config.git.pushFlags],
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
			const pushedTags = pushTagsTracked(config, tag, newVersion, true);
			tagSpinner.stop("Pushed to GitHub");
			return pushedTags;
		} catch (tagErr) {
			tagSpinner.stop(pc.red("Tag push failed"));
			throw tagErr;
		}
	}

	try {
		const pushedTags = pushTagsTracked(config, tag, newVersion, true);
		spinner.stop("Pushed to GitHub");
		return pushedTags;
	} catch (tagErr) {
		spinner.stop(pc.red("Tag push failed"));
		throw tagErr;
	}
}
