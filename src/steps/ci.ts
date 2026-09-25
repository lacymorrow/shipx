import * as p from "@clack/prompts";
import pc from "picocolors";
import type { ResolvedConfig } from "../types.ts";
import { restoreCursor, run, sleep } from "../utils.ts";

export interface CiRun {
	databaseId: number;
	workflowName: string;
	headBranch: string;
	/** "queued" | "in_progress" | "completed" | ... */
	status: string;
	/** "" until the run completes, then "success" | "failure" | "cancelled" | ... */
	conclusion: string;
	url: string;
	createdAt: string;
	updatedAt: string;
}

export interface CiWatchResult {
	succeeded: CiRun[];
	failed: CiRun[];
	/** Runs still queued or in progress when the watch cap was hit */
	pending: CiRun[];
	/** Pushed tags that never triggered a workflow run — the silent-misconfiguration case */
	missingTags: string[];
}

export interface CiWatchOptions {
	/** How long to wait for runs to appear after the tag push. Default: 15s */
	discoveryTimeoutMs?: number;
	/** Overall cap on the watch; runs still going are reported as pending. Default: 5min */
	watchTimeoutMs?: number;
	/** Delay between polls. Default: 5s */
	pollIntervalMs?: number;
}

/** Steps the config delegates to CI via tag push instead of running locally. */
export function ciDelegatedSteps(steps: { githubRelease: boolean; homebrew: boolean }): string[] {
	const delegated: string[] = [];
	if (!steps.githubRelease) delegated.push("GitHub Release");
	if (!steps.homebrew) delegated.push("Homebrew");
	return delegated;
}

export async function isGhAvailable(): Promise<boolean> {
	try {
		await run("gh", ["--version"]);
		return true;
	} catch {
		return false;
	}
}

const RUN_JSON_FIELDS = "databaseId,workflowName,headBranch,status,conclusion,url,createdAt,updatedAt";

async function listRunsForTag(root: string, tag: string): Promise<CiRun[]> {
	// A tag push triggers runs whose headBranch is the tag name, so --branch
	// filters to exactly the runs this release kicked off. Tag names are
	// unique per release, so no time filtering is needed.
	const out = await run(
		"gh",
		["run", "list", "--branch", tag, "--json", RUN_JSON_FIELDS, "--limit", "50"],
		{ cwd: root },
	);
	return JSON.parse(out) as CiRun[];
}

function isDone(ciRun: CiRun): boolean {
	return ciRun.status === "completed";
}

function isOk(ciRun: CiRun): boolean {
	return ciRun.conclusion === "success" || ciRun.conclusion === "skipped";
}

function formatDuration(ciRun: CiRun): string {
	const start = Date.parse(ciRun.createdAt);
	const end = Date.parse(ciRun.updatedAt);
	if (Number.isNaN(start) || Number.isNaN(end) || end < start) return "";
	const totalSeconds = Math.round((end - start) / 1000);
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	return minutes > 0 ? `${minutes}m${String(seconds).padStart(2, "0")}s` : `${seconds}s`;
}

function reportRun(ciRun: CiRun): void {
	const duration = formatDuration(ciRun);
	const parts = [pc.cyan(ciRun.workflowName), pc.dim(ciRun.headBranch)];
	if (isDone(ciRun) && isOk(ciRun)) {
		parts.push(pc.green(ciRun.conclusion), pc.dim(duration));
	} else if (isDone(ciRun)) {
		parts.push(pc.red(ciRun.conclusion.toUpperCase()), pc.dim(duration), ciRun.url);
	} else {
		parts.push(pc.yellow(ciRun.status), ciRun.url);
	}
	p.log.message(`  ${parts.filter(Boolean).join("  ")}`);
}

/**
 * Watch the workflow runs the pushed tags triggered and report what they did,
 * instead of assuming a tag push means CI succeeded. Polls `gh run list` per
 * tag until every discovered run completes or the watch cap is hit.
 *
 * Ctrl-C during the watch exits 0: the release itself is already done, so an
 * interrupted watch must not read as a failed release. The run URLs are
 * printed so the watch can continue in the browser.
 */
export async function watchCiRuns(
	config: ResolvedConfig,
	pushedTags: string[],
	options?: CiWatchOptions,
): Promise<CiWatchResult> {
	const discoveryTimeoutMs = options?.discoveryTimeoutMs ?? 15_000;
	const watchTimeoutMs = options?.watchTimeoutMs ?? 5 * 60_000;
	const pollIntervalMs = options?.pollIntervalMs ?? 5_000;

	const known = new Map<number, CiRun>();
	// A tag-triggered run's headBranch is the tag name, so which tags have
	// runs is derivable from `known` — one source of truth.
	const tagsWithRuns = () => new Set([...known.values()].map((r) => r.headBranch));

	const spinner = p.spinner();
	spinner.start(`Watching CI runs for ${pushedTags.map((t) => pc.cyan(t)).join(", ")}`);

	// setupCleanExit's SIGINT handler exits 130, which would make an
	// interrupted watch look like a failed release. Swap it out for the
	// duration of the watch and restore it after.
	const priorSigintListeners = process.listeners("SIGINT");
	const onSigint = () => {
		spinner.stop(pc.yellow("CI watch interrupted — the release itself is already done"));
		for (const ciRun of known.values()) {
			if (!isDone(ciRun)) p.log.message(`  ${pc.cyan(ciRun.workflowName)}  ${ciRun.url}`);
		}
		restoreCursor();
		process.exit(0);
	};
	process.removeAllListeners("SIGINT");
	process.on("SIGINT", onSigint);

	try {
		const pollAll = async (): Promise<void> => {
			const results = await Promise.allSettled(
				pushedTags.map((tag) => listRunsForTag(config.root, tag)),
			);
			for (const result of results) {
				// A rejected poll is a transient gh failure — keep what we know.
				if (result.status !== "fulfilled") continue;
				for (const ciRun of result.value) known.set(ciRun.databaseId, ciRun);
			}
		};

		// Discovery: runs are usually queued within seconds of the push. If a
		// tag still has none after the window, its workflow trigger most
		// likely doesn't match — the case that is silent today.
		const discoveryDeadline = Date.now() + discoveryTimeoutMs;
		await pollAll();
		while (tagsWithRuns().size < pushedTags.length && Date.now() < discoveryDeadline) {
			await sleep(Math.min(pollIntervalMs, 3_000));
			await pollAll();
		}

		// Watch: poll until every known run completes or the cap is hit. New
		// runs that appear mid-watch (delayed workflows) are picked up too.
		// Tags that stayed empty through discovery are settled — they get a
		// warning below, not a wait until the cap.
		const watchDeadline = Date.now() + watchTimeoutMs;
		const allDone = () => [...known.values()].every(isDone);
		while (!allDone() && Date.now() < watchDeadline) {
			const pendingCount = [...known.values()].filter((r) => !isDone(r)).length;
			spinner.message(`Watching CI runs — ${pendingCount} of ${known.size} still running`);
			await sleep(pollIntervalMs);
			await pollAll();
		}

		const runs = [...known.values()];
		const result: CiWatchResult = {
			succeeded: runs.filter((r) => isDone(r) && isOk(r)),
			failed: runs.filter((r) => isDone(r) && !isOk(r)),
			pending: runs.filter((r) => !isDone(r)),
			missingTags: pushedTags.filter((t) => !tagsWithRuns().has(t)),
		};

		if (result.failed.length) {
			spinner.stop(pc.red(`CI failed — ${result.failed.length} of ${runs.length} run(s) did not succeed`));
		} else if (result.pending.length) {
			spinner.stop(pc.yellow(`CI still running after ${Math.round(watchTimeoutMs / 60_000)}min — ${result.pending.length} run(s) pending`));
		} else if (runs.length) {
			spinner.stop(pc.green(`CI passed — ${runs.length} run(s) succeeded`));
		} else {
			spinner.stop(pc.yellow("No CI runs found for the pushed tag(s)"));
		}

		for (const ciRun of runs) reportRun(ciRun);
		for (const tag of result.missingTags) {
			p.log.warn(
				`No workflow run appeared for tag ${pc.cyan(tag)}. ` +
				`If CI should handle this tag, check the workflow's trigger pattern.`,
			);
		}
		if (result.pending.length) {
			p.log.info("Still running — check later:");
			for (const ciRun of result.pending) p.log.message(`  ${pc.dim(ciRun.url)}`);
		}

		return result;
	} finally {
		process.removeListener("SIGINT", onSigint);
		for (const listener of priorSigintListeners) process.on("SIGINT", listener);
	}
}
