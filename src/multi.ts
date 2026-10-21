import * as p from "@clack/prompts";
import pc from "picocolors";
import { resolve } from "node:path";
import { configFileLabel, loadConfig } from "./config.ts";
import { runHook } from "./hooks.ts";
import { isUnpublishablePackage } from "./detect.ts";
import { discoverProjects, type DiscoveredProject, type DiscoverResult } from "./discover.ts";
import { computeIgnoredAfterSelection, loadIgnored, saveIgnored } from "./ignore.ts";
import { isNonInteractive } from "./interactive.ts";
import { bumpCargoWorkspaces } from "./steps/cargo.ts";
import { ciDelegatedSteps, isGhAvailable, watchCiRuns, type CiWatchResult } from "./steps/ci.ts";
import { bumpVersionFiles, getFilesToStage } from "./steps/bump.ts";
import { generateChangelog } from "./steps/changelog.ts";
import { updateChangelogFile } from "./steps/changelog-file.ts";
import { createGithubRelease } from "./steps/github.ts";
import { commitAndTag, pushChanges } from "./steps/git.ts";
import { publishHomebrew } from "./steps/homebrew.ts";
import { publishNpm } from "./steps/npm.ts";
import { pickVersion } from "./steps/version.ts";
import { reconcileRegistryVersion } from "./registry.ts";
import { branchExists, errorText, exec, readJson, setupCleanExit } from "./utils.ts";
import type { ResolvedConfig } from "./types.ts";

setupCleanExit();

export interface NpmAuthOption {
	value: "web" | "otp" | "none";
	label: string;
	hint: string;
}

export function buildNpmAuthOptions(packageCount: number): NpmAuthOption[] {
	const isMulti = packageCount > 1;
	return [
		{
			value: "web",
			label: "Web auth (passkey)",
			hint: isMulti
				? "recommended — authenticates each publish in browser"
				: "authenticate in browser",
		},
		{
			value: "otp",
			label: "Enter OTP code",
			hint: isMulti
				? "will prompt for a fresh code per package (OTPs are single-use)"
				: "publish with one-time password",
		},
		{
			value: "none",
			label: "No auth needed",
			hint: "token already configured",
		},
	];
}

interface BatchProject {
	dirName: string;
	config: ResolvedConfig;
	isBeta: boolean;
	distTag?: string;
}

type PublishFn = (
	config: ResolvedConfig,
	isBeta: boolean,
	opts?: { otp?: string; webAuth?: boolean; distTag?: string },
) => Promise<boolean>;

type PromptOtpFn = (dirName: string) => Promise<string | undefined>;

async function defaultPromptOtp(dirName: string): Promise<string | undefined> {
	const otpInput = await p.text({
		message: `npm OTP for ${dirName}`,
		placeholder: "123456",
		validate: (v) => {
			if (!v || !/^\d{6}$/.test(v.trim())) return "OTP must be 6 digits";
		},
	});
	if (p.isCancel(otpInput)) return undefined;
	return otpInput.trim();
}

export async function batchPublishNpm(
	projects: BatchProject[],
	authMethod: "web" | "otp" | "none",
	overrides?: { publishFn?: PublishFn; promptOtpFn?: PromptOtpFn },
): Promise<{ name: string; success: boolean }[]> {
	const publish = overrides?.publishFn ?? publishNpm;
	const promptOtp = overrides?.promptOtpFn ?? defaultPromptOtp;
	const webAuth = authMethod === "web";
	const results: { name: string; success: boolean }[] = [];

	for (const pp of projects) {
		p.log.message(`  ${pc.cyan("→")} ${pp.dirName}`);

		let otp: string | undefined;
		if (authMethod === "otp") {
			otp = await promptOtp(pp.dirName);
		}

		const success = await publish(pp.config, pp.isBeta, { otp, webAuth, distTag: pp.distTag });
		results.push({ name: pp.dirName, success });
	}

	return results;
}

export interface BatchCiProject {
	dirName: string;
	config: ResolvedConfig;
	/** Tags pushChanges actually pushed for this project's release. */
	pushedTags: string[];
}

type WatchCiFn = (config: ResolvedConfig, pushedTags: string[]) => Promise<CiWatchResult>;

/** The projects in a batch whose configs delegate a step to CI via tag push. */
function ciEligibleProjects(projects: BatchCiProject[]): BatchCiProject[] {
	return projects.filter(
		(pp) =>
			pp.config.steps.watchCi &&
			pp.config.steps.push &&
			ciDelegatedSteps(pp.config.steps).length > 0,
	);
}

/**
 * Watch the tag-triggered CI runs for every project in the batch that
 * delegates a step (GitHub release, Homebrew) to CI. Multi mode pushes tags
 * during the prepare phase and previously never looked at Actions — the same
 * silent-trust problem #59 fixed for single-project releases (issue #62).
 */
export async function watchBatchCi(
	projects: BatchCiProject[],
	overrides?: { watchFn?: WatchCiFn; isGhAvailableFn?: () => Promise<boolean> },
): Promise<{ name: string; result: CiWatchResult }[]> {
	const eligible = ciEligibleProjects(projects).filter((pp) => pp.pushedTags.length > 0);
	if (!eligible.length) return [];

	const ghAvailable = overrides?.isGhAvailableFn ?? isGhAvailable;
	if (!(await ghAvailable())) {
		p.log.warn(
			`Cannot watch CI runs for ${eligible.map((pp) => pc.cyan(pp.dirName)).join(", ")}: gh not found on PATH`,
		);
		return [];
	}

	const watch = overrides?.watchFn ?? watchCiRuns;
	const results: { name: string; result: CiWatchResult }[] = [];
	for (const pp of eligible) {
		p.log.message(
			`  ${pc.cyan("→")} ${pp.dirName} ${pc.dim(`(${ciDelegatedSteps(pp.config.steps).join(", ")})`)}`,
		);
		results.push({ name: pp.dirName, result: await watch(pp.config, pp.pushedTags) });
	}
	return results;
}

/** What actually happened to one project in a batch. */
export type ProjectStatus =
	| "released"
	| "prepare-failed"
	| "publish-failed"
	| "publish-skipped"
	| "ci-failed"
	| "ci-missing"
	| "ci-pending";

export interface BatchOutcome {
	/** Projects that got as far as a tag, in release order. */
	prepared: { name: string; tag: string }[];
	/** Projects whose prepare threw. May overlap `prepared` (tag was pushed). */
	prepareFailures: string[];
	/** Phase 2 result for each project that had something to publish. */
	publishResults: { name: string; success: boolean }[];
	/** Projects whose publish never ran because the auth prompt was cancelled. */
	publishSkipped: string[];
	ci: { name: string; result: CiWatchResult }[];
	nonInteractive: boolean;
}

export interface BatchVerdict {
	/** Whether the run should exit non-zero. */
	failed: boolean;
	/** One entry per project: `prepared` order, then prepare-only failures. */
	statuses: { name: string; tag: string; status: ProjectStatus }[];
	/** Short phrases naming what went wrong, for the outro line. */
	problems: string[];
}

/**
 * What a batch run should report and exit with.
 *
 * Batch mode used to count only failed CI runs, so a batch where every npm
 * publish was rejected exited 0 and printed a ✓ per project — the tags were
 * out, no package was (#74). Three sources count now, each for its own reason:
 *
 *   - A prepare that threw is never a deliberate choice, so it always fails.
 *   - A rejected publish fails an unattended run only, mirroring the
 *     single-project rule (#69): interactively, `publishNpm` returning false
 *     can be someone choosing to skip, and they have already read the warning.
 *   - A failed CI run fails, as before.
 */
export function summarizeBatch(outcome: BatchOutcome): BatchVerdict {
	const ciByName = new Map(outcome.ci.map((r) => [r.name, r.result]));
	const prepareFailed = new Set(outcome.prepareFailures);
	const publishFailed = new Set(
		outcome.publishResults.filter((r) => !r.success).map((r) => r.name),
	);
	const publishSkipped = new Set(outcome.publishSkipped);

	const statuses = outcome.prepared.map(({ name, tag }) => {
		const ci = ciByName.get(name);
		let status: ProjectStatus = "released";
		if (prepareFailed.has(name)) status = "prepare-failed";
		else if (publishFailed.has(name)) status = "publish-failed";
		else if (publishSkipped.has(name)) status = "publish-skipped";
		else if (ci?.failed.length) status = "ci-failed";
		else if (ci?.missingTags.length) status = "ci-missing";
		else if (ci?.pending.length) status = "ci-pending";
		return { name, tag, status };
	});

	// A prepare that failed before pushing anything is absent from `prepared`,
	// so it would not appear in the summary at all without this.
	const listed = new Set(statuses.map((s) => s.name));
	for (const name of outcome.prepareFailures) {
		if (!listed.has(name)) {
			statuses.push({ name, tag: "", status: "prepare-failed" });
			listed.add(name);
		}
	}

	// Counts only: which project is which is on the per-project lines right
	// below this in the outro, so repeating the names here just reads badly.
	const failedRunCount = outcome.ci.reduce((n, r) => n + r.result.failed.length, 0);
	const problems: string[] = [];
	if (prepareFailed.size) {
		problems.push(`${prepareFailed.size} project${prepareFailed.size === 1 ? "" : "s"} failed`);
	}
	if (publishFailed.size) {
		problems.push(`${publishFailed.size} npm publish${publishFailed.size === 1 ? "" : "es"} failed`);
	}
	if (publishSkipped.size) {
		problems.push(`${publishSkipped.size} npm publish${publishSkipped.size === 1 ? "" : "es"} skipped`);
	}
	if (failedRunCount > 0) {
		problems.push(`${failedRunCount} CI run${failedRunCount === 1 ? "" : "s"} failed, see the run URL(s) above`);
	}

	const failed =
		prepareFailed.size > 0 ||
		failedRunCount > 0 ||
		(publishFailed.size > 0 && outcome.nonInteractive);

	return { failed, statuses, problems };
}

export interface PipelineState {
	didBump: boolean;
	didCommit: boolean;
	didPush: boolean;
	didComputeBumpedFiles: boolean;
	bumpedFiles: string[];
}

export interface PipelineFailureResult {
	needsRollback: boolean;
	canContinueToPublish: boolean;
	partialStateWarning: string;
}

export function classifyPipelineFailure(state: PipelineState): PipelineFailureResult {
	if (!state.didBump && !state.didCommit && !state.didPush) {
		return { needsRollback: false, canContinueToPublish: false, partialStateWarning: "" };
	}
	if (state.didPush) {
		return {
			needsRollback: false,
			canContinueToPublish: true,
			partialStateWarning: "Commit and tag were pushed to remote — project can still be published",
		};
	}
	if (state.didCommit) {
		return {
			needsRollback: true,
			canContinueToPublish: false,
			partialStateWarning: "Commit and tag exist locally but were not pushed",
		};
	}
	return {
		needsRollback: true,
		canContinueToPublish: false,
		partialStateWarning: "Version files were bumped but not committed",
	};
}

function rollbackProjectRelease(
	root: string,
	tag: string,
	extraTags: string[],
	state: PipelineState,
): void {
	const allTags = [tag, ...extraTags];

	if (state.didCommit) {
		for (const t of allTags) {
			try {
				exec("git", ["tag", "-d", t], { cwd: root });
			} catch {
				// tag may not exist
			}
		}
		try {
			exec("git", ["reset", "--soft", "HEAD~1"], { cwd: root });
			p.log.info("Rolled back locally: removed tag(s) and undid release commit");
		} catch {
			p.log.error("Failed to reset commit — you may need to clean up manually");
		}
	}

	if (state.didBump && !state.didCommit && state.bumpedFiles.length) {
		try {
			exec("git", ["checkout", "--", ...state.bumpedFiles], { cwd: root });
			p.log.info("Reverted bumped files");
		} catch {
			p.log.error("Failed to revert bumped files — you may need to clean up manually");
		}
	}
}

interface PreparedProject {
	project: DiscoveredProject;
	config: ResolvedConfig;
	newVersion: string;
	tag: string;
	changelog: string;
	isBeta: boolean;
	pushedTags: string[];
}

/**
 * Re-read the current state of every npm publish target and update
 * `project.hasNpm` / `project.private` / `project.name` accordingly.
 *
 * Discover reads the working tree once at scan time. After that, the user can:
 *   - switch the project's branch (changing package.json content), or
 *   - have configured `npm.cwd` / `npm.targets` pointing at a subpackage that
 *     wasn't visible at discover time.
 *
 * Both make `project.hasNpm` stale. We re-derive from whatever package.json
 * files `npm publish` will actually read at the moment of decision, so a
 * project never gets a tag + GitHub release without an npm publish purely
 * because state went stale (see LAC-2090).
 */
export function reevaluateProjectPublishability(
	project: DiscoveredProject,
	config: ResolvedConfig,
): void {
	if (!config.steps.npm) {
		project.hasNpm = false;
		return;
	}

	let anyPublishable = false;
	for (const target of config.npm.targets) {
		try {
			const pkg = readJson(resolve(target.cwd, "package.json"));
			// Single source of truth: isUnpublishablePackage covers private,
			// workspaces, AND the no-entry-points case. Inlining the check
			// here previously missed the entry-points reason (caught by
			// Gemini on PR #49).
			const isPublishable = isUnpublishablePackage(pkg) === null;
			if (isPublishable) {
				anyPublishable = true;
				// Prefer the published-package name over the root dir name for
				// registry-version reconciliation later.
				if (typeof pkg.name === "string") project.name = pkg.name;
				if (target.cwd === project.path) project.private = false;
			} else if (target.cwd === project.path) {
				project.private = pkg.private === true;
			}
		} catch {
			// unreadable target — treat as not publishable
		}
	}
	project.hasNpm = anyPublishable;
}

function parseFlag(argv: string[], flag: string): string | undefined {
	const idx = argv.indexOf(flag);
	if (idx === -1 || idx === argv.length - 1) return undefined;
	return argv[idx + 1];
}

/** Flags that consume the argument after them, so it is not a positional. */
const VALUE_FLAGS = new Set(["--tag", "--otp"]);

/**
 * The positional arguments in a batch argv, flags and their values removed.
 * Mirrors how single-project mode arrives at its bump argument.
 */
export function positionalArgs(argv: string[]): string[] {
	const positional: string[] = [];
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (VALUE_FLAGS.has(arg)) {
			i++;
			continue;
		}
		if (arg.startsWith("-")) continue;
		positional.push(arg);
	}
	return positional;
}

/** How a batch picks each project's new version. */
export type BumpMode = "individual" | "patch" | "minor" | "major";

export type BumpModeResolution =
	| { kind: "named"; mode: "patch" | "minor" | "major" }
	| { kind: "ask" }
	| { kind: "error"; message: string };

/**
 * How a batch decides its bump strategy.
 *
 * A level named on the command line answers it outright. Unattended, nothing
 * else can: the strategy select has no safe default, and quietly assuming
 * `patch` would release every project in the directory on a guess — the same
 * reasoning that makes `canAutoConfirmRelease` require a named bump. So an
 * unattended run with no level says so and exits non-zero, which is a
 * determinate answer rather than the prompt-into-closed-stdin stall (#70).
 *
 * An explicit version is single-project only: one version string cannot mean
 * anything sensible across a batch. Batch mode used to ignore every positional
 * argument, so `shipx --multi 2.0.0` silently did something else entirely.
 */
export function resolveBumpMode(
	bumpArg: string | undefined,
	nonInteractive: boolean,
): BumpModeResolution {
	if (bumpArg === "patch" || bumpArg === "minor" || bumpArg === "major") {
		return { kind: "named", mode: bumpArg };
	}
	if (bumpArg !== undefined) {
		return {
			kind: "error",
			message: /^\d+\.\d+\.\d+/.test(bumpArg)
				? `--multi cannot take an explicit version (${bumpArg}) — each project bumps from its own. Use patch, minor, or major.`
				: `Unknown bump level "${bumpArg}". Use patch, minor, or major.`,
		};
	}
	if (nonInteractive) {
		return {
			kind: "error",
			message:
				"No bump level given, and nothing here can pick one for a whole directory of projects.\n" +
				`  Name it: ${pc.green("shipx --multi patch --yes")}`,
		};
	}
	return { kind: "ask" };
}

export async function multiMain(argv: string[]): Promise<void> {
	const isBeta = argv.includes("--beta");
	const isDraft = argv.includes("--draft");
	const isDryRun = argv.includes("--dry-run");
	const isAnyBranch = argv.includes("--any-branch");
	const noWatchCi = argv.includes("--no-watch-ci");
	const customTag = parseFlag(argv, "--tag");
	if (argv.includes("--tag") && !customTag) {
		p.log.error("--tag requires a value (e.g. --tag next)");
		process.exit(1);
	}
	const root = process.env.SHIPX_ROOT ?? process.cwd();

	if (process.stdout.isTTY) {
		console.clear();
	}
	const modeLabel = isDryRun ? " (Dry Run)" : "";
	p.intro(pc.magenta(pc.bold(`  shipx — Multi-Project Deploy${modeLabel}  `)));

	if (isDryRun) {
		p.log.info(pc.dim("Dry-run mode — no changes will be made"));
	}

	// Resolve the bump strategy before the scan: an unattended run with no
	// level named cannot proceed, and finding that out after a minute of
	// subprocess work wastes the caller's time.
	const bumpResolution = resolveBumpMode(positionalArgs(argv)[0], isNonInteractive());
	if (bumpResolution.kind === "error") {
		p.log.error(bumpResolution.message);
		process.exitCode = 1;
		p.outro(pc.red("Nothing was released."));
		console.log();
		return;
	}

	const spinner = p.spinner();
	spinner.start("Scanning for projects");
	const { projects, skipped } = await discoverProjects(root, (scanned, found, current) => {
		spinner.message(`Scanning: ${pc.dim(current)} ${pc.dim(`(${found} found)`)}`);
	});
	spinner.stop(`Found ${pc.cyan(String(projects.length))} projects`);

	if (skipped.length) {
		p.log.warn(`Skipped ${skipped.length} project${skipped.length === 1 ? "" : "s"} with unreadable package.json: ${pc.dim(skipped.join(", "))}`);
	}

	if (!projects.length) {
		p.log.error("No deployable projects found. Run from a directory containing project subdirectories.");
		process.exit(1);
	}

	const withChanges = projects.filter((proj) => proj.changeCount > 0);
	const clean = projects.filter((proj) => proj.changeCount === 0);

	if (withChanges.length) {
		p.log.info(`${pc.green(String(withChanges.length))} projects with unreleased changes`);
	}
	if (clean.length) {
		p.log.info(`${pc.dim(String(clean.length))} projects up to date`);
	}

	const ignored = loadIgnored(root);
	if (ignored.size) {
		p.log.info(`${pc.dim(String(ignored.size))} projects in .shipxignore`);
	}

	const archived = projects.filter((proj) => proj.archived);
	if (archived.length) {
		p.log.warn(
			`${pc.yellow(String(archived.length))} archived repo${archived.length === 1 ? "" : "s"} will be skipped (read-only on GitHub): ` +
			archived.map((proj) => pc.dim(proj.dirName)).join(", "),
		);
	}

	const options = projects
		.filter((proj) => !proj.archived)
		.map((proj) => {
			const changes = proj.changeCount > 0
				? pc.yellow(`${proj.changeCount} new commit${proj.changeCount === 1 ? "" : "s"}`)
				: pc.dim("no changes");
			const dirtyFlag = proj.dirty ? pc.red(" [dirty]") : "";
			const npmFlag = proj.hasNpm ? "" : pc.dim(proj.private ? " (private)" : " (workspace)");
			const nameNote = proj.name !== proj.dirName ? pc.dim(` [${proj.name}]`) : "";
			return {
				value: proj.path,
				label: `${proj.dirName}${npmFlag}${nameNote}`,
				hint: `${pc.dim(proj.version)} · ${changes}${dirtyFlag}`,
			};
		});

	if (!options.length) {
		p.log.info("No deployable projects after filtering archived repos.");
		p.outro(pc.dim("Nothing to do."));
		console.log();
		return;
	}

	const preSelected = withChanges
		.filter((proj) => !proj.archived && !ignored.has(proj.dirName))
		.map((proj) => proj.path);

	let selectedPaths: string[];
	if (isNonInteractive()) {
		// The pre-ticked set is already "has unreleased changes, not archived,
		// not in .shipxignore" — the answer a person would have accepted. An
		// empty set is nothing to do rather than a failure: a scheduled release
		// over a directory where nothing changed should exit 0.
		selectedPaths = preSelected;
		if (!selectedPaths.length) {
			p.log.info("No projects with unreleased changes to select.");
			p.outro(pc.dim("Nothing to do."));
			console.log();
			return;
		}
		p.log.info(
			`Releasing ${pc.cyan(String(selectedPaths.length))} project${selectedPaths.length === 1 ? "" : "s"} with unreleased changes ${pc.dim("(auto-selected, non-interactive)")}`,
		);
	} else {
		const selected = await p.multiselect({
			message: "Select projects to release",
			options,
			initialValues: preSelected,
			required: true,
		});

		if (p.isCancel(selected)) {
			p.cancel("Release cancelled.");
			console.log();
			process.exit(0);
		}
		selectedPaths = selected as string[];
	}

	const selectedProjects = projects.filter((proj) => selectedPaths.includes(proj.path));

	// LAC-2017: only persist the user's explicit delta to .shipxignore. The
	// previous logic rewrote ignored = "every project not currently selected",
	// which silently dumped every clean/no-change repo in the parent directory
	// into .shipxignore on each default-accept run.
	const preSelectedDirNames = new Set(
		projects.filter((proj) => preSelected.includes(proj.path)).map((proj) => proj.dirName),
	);
	const selectedDirNames = new Set(selectedProjects.map((proj) => proj.dirName));
	const nextIgnored = computeIgnoredAfterSelection({
		previousIgnored: ignored,
		preSelectedDirNames,
		selectedDirNames,
	});
	const ignoredChanged =
		nextIgnored.size !== ignored.size ||
		[...nextIgnored].some((name) => !ignored.has(name));
	if (ignoredChanged) {
		saveIgnored(root, nextIgnored);
	}

	const dirtySelected = selectedProjects.filter((proj) => proj.dirty);
	if (dirtySelected.length) {
		p.log.warn("These projects have uncommitted changes:");
		for (const proj of dirtySelected) {
			p.log.message(`  ${pc.yellow("●")} ${proj.dirName}`);
		}
		if (isNonInteractive()) {
			// `--yes` means yes. An uncommitted tree can still break the release,
			// so say that it was waved through rather than abort the whole batch
			// over a stray file.
			p.log.warn(`Continuing anyway ${pc.dim("(auto-confirmed, non-interactive)")} — uncommitted work is not part of the release.`);
		} else {
			const proceed = await p.confirm({
				message: "Continue anyway? (dirty projects will fail preflight)",
				initialValue: false,
			});
			if (p.isCancel(proceed) || !proceed) {
				p.cancel("Release cancelled.");
				console.log();
				process.exit(0);
			}
		}
	}

	let bumpMode: BumpMode;
	if (bumpResolution.kind === "named") {
		bumpMode = bumpResolution.mode;
		p.log.info(`Bumping every project as ${pc.cyan(bumpMode)} ${pc.dim("(from the command line)")}`);
	} else {
		const selected = await p.select({
			message: "Version bump strategy",
			options: [
				{ value: "individual" as const, label: "Pick per project", hint: "choose bump type for each" },
				{ value: "patch" as const, label: "Patch all", hint: "bump all selected as patch" },
				{ value: "minor" as const, label: "Minor all", hint: "bump all selected as minor" },
				{ value: "major" as const, label: "Major all", hint: "bump all selected as major" },
			],
		});

		if (p.isCancel(selected)) {
			p.cancel("Release cancelled.");
			console.log();
			process.exit(0);
		}
		bumpMode = selected;
	}

	// Phase 1: Prepare all projects (version, bump, commit, tag, push)
	p.log.step(pc.bold("Phase 1: Prepare releases"));
	const prepared: PreparedProject[] = [];
	/** Projects whose prepare threw. Never a deliberate skip, so always a failure. */
	const prepareFailures: string[] = [];

	for (const project of selectedProjects) {
		p.log.step(`${pc.cyan(project.dirName)} ${pc.dim(`(${project.version})`)}`);

		const config = await loadConfig(project.path);
		if (isDraft) config.github.draft = true;
		if (isDryRun) config.dryRun = true;
		if (isAnyBranch) config.anyBranch = true;
		if (customTag) config.tag = customTag;
		if (noWatchCi) config.steps.watchCi = false;

		// Re-derive npm publishability from the loaded config (config targets
		// are authoritative over discover-time detection: explicit npm.cwd or
		// auto-detected subpackage may differ from the project root).
		reevaluateProjectPublishability(project, config);

		if (!isBeta && !isAnyBranch && project.branch !== config.git.releaseBranch) {
			// Releasing off the wrong branch, or checking out a different one, is
			// not a decision to make for someone who is not here. `--any-branch`
			// is how a caller says yes to it up front.
			if (isNonInteractive()) {
				p.log.warn(
					`Skipping ${pc.yellow(project.dirName)}: on '${pc.yellow(project.branch)}', not '${config.git.releaseBranch}'.\n` +
					`  Pass ${pc.green("--any-branch")} to release from the current branch.`,
				);
				continue;
			}

			const canSwitch = branchExists(project.path, config.git.releaseBranch);
			const switchOption = canSwitch
				? [{ value: "switch" as const, label: `Switch to ${config.git.releaseBranch}`, hint: `git checkout ${config.git.releaseBranch}` }]
				: [];
			const branchAction = await p.select({
				message: `${project.dirName} is on '${pc.yellow(project.branch)}', not '${config.git.releaseBranch}'.`,
				options: [
					...switchOption,
					{ value: "use" as const, label: `Use ${project.branch}`, hint: "release from current branch" },
					{ value: "skip" as const, label: "Skip", hint: "don't release this project" },
				],
			});

			if (p.isCancel(branchAction) || branchAction === "skip") {
				p.log.info(`Skipping ${project.dirName}`);
				continue;
			}

			if (branchAction === "switch") {
				try {
					exec("git", ["checkout", config.git.releaseBranch], { cwd: project.path });
					project.branch = config.git.releaseBranch;
					p.log.success(`Switched ${project.dirName} to ${config.git.releaseBranch}`);
				} catch (err) {
					p.log.error(`Failed to switch branch: ${errorText(err)}`);
					continue;
				}

				// Branch switch changes package.json content — re-evaluate
				// publishability so the new branch's `private` / entry-points
				// drive Phase 2 (not the stale pre-switch working tree). Without
				// this, a tag + GitHub release can be produced while npm publish
				// silently skips. See LAC-2090.
				const wasNpm = project.hasNpm;
				reevaluateProjectPublishability(project, config);
				if (wasNpm !== project.hasNpm) {
					p.log.info(
						`${project.dirName}: npm publishability changed after branch switch — ${pc.yellow(String(wasNpm))} → ${pc.green(String(project.hasNpm))}`,
					);
				}
			}
		}

		let baseVersion = project.version;
		if (config.versionSource) {
			const vsPath = resolve(project.path, config.versionSource);
			try {
				const vs = readJson(vsPath);
				if (typeof vs.version === "string") baseVersion = vs.version;
			} catch {
				p.log.warn(`Could not read versionSource at ${pc.cyan(config.versionSource)} — using detected version ${pc.dim(project.version)}`);
			}
		}
		if (config.steps.npm && project.hasNpm) {
			baseVersion = await reconcileRegistryVersion(
				project.name,
				project.version,
				config.npm.cwd,
				{ displayName: project.dirName },
			);
		}

		const versionArg = bumpMode === "individual" ? undefined : bumpMode;
		const newVersion = await pickVersion(baseVersion, versionArg, isBeta);
		const tag = `${config.git.tagPrefix}${newVersion}`;

		const releaseLine = `${project.dirName}: ${pc.cyan(baseVersion)} → ${pc.green(newVersion)} (${tag})`;
		if (isNonInteractive()) {
			p.log.info(`${releaseLine} ${pc.dim("(auto-confirmed, non-interactive)")}`);
		} else {
			const proceed = await p.confirm({ message: `${releaseLine}?` });
			if (p.isCancel(proceed) || !proceed) {
				p.log.info(`Skipping ${project.dirName}`);
				continue;
			}
		}

		const pstate: PipelineState = {
			didBump: false,
			didCommit: false,
			didPush: false,
			didComputeBumpedFiles: false,
			bumpedFiles: [],
		};
		let changelog = `- Release ${tag}`;
		let pushedTags: string[] = [];
		const hookCtx = () => ({ config, version: newVersion, tag, changelog, isBeta });
		try {
			let cargoStagePaths: string[] = [];
			if (config.steps.bumpVersion) {
				await runHook("preBump", config.hooks.preBump, hookCtx());
				if (isDryRun) {
					const files = [...config.packageJsonPaths, ...config.bumpFiles.map((f: { path: string }) => f.path)];
					p.log.info(`${pc.dim("[dry-run]")} Would bump: ${files.map((f: string) => pc.cyan(f)).join(", ")}`);
				} else {
					bumpVersionFiles(config, newVersion);
					cargoStagePaths = await bumpCargoWorkspaces(config, newVersion);
					pstate.didBump = true;
					pstate.bumpedFiles = [...getFilesToStage(config), ...cargoStagePaths];
					pstate.didComputeBumpedFiles = true;
				}
				await runHook("postBump", config.hooks.postBump, hookCtx());
			}

			if (config.steps.changelog) {
				await runHook("preChangelog", config.hooks.preChangelog, hookCtx());
				if (isDryRun) {
					p.log.info(`${pc.dim("[dry-run]")} Would generate changelog`);
					if (config.changelogFile) {
						p.log.info(`${pc.dim("[dry-run]")} Would add ${pc.green(newVersion)} to ${pc.cyan(config.changelogFile)} if it exists`);
					}
				} else {
					const generated = generateChangelog(config, tag);
					changelog = generated.body;
					const changelogPath = updateChangelogFile(config, newVersion, tag, generated.commits);
					if (changelogPath) {
						// The commit step stages pstate.bumpedFiles, so the changelog has to join it
						// there or it would be written and then left out of the release commit.
						if (!pstate.didComputeBumpedFiles) {
							pstate.bumpedFiles = [...getFilesToStage(config), ...cargoStagePaths];
							pstate.didComputeBumpedFiles = true;
						}
						pstate.bumpedFiles.push(changelogPath);
					}
				}
				await runHook("postChangelog", config.hooks.postChangelog, hookCtx());
			}

			if (config.steps.commit || config.steps.tag) {
				await runHook("preCommit", config.hooks.preCommit, hookCtx());
				if (isDryRun) {
					p.log.info(`${pc.dim("[dry-run]")} Would commit and tag ${pc.green(tag)}`);
				} else {
					if (!pstate.didComputeBumpedFiles) {
						pstate.bumpedFiles = [...getFilesToStage(config), ...cargoStagePaths];
						pstate.didComputeBumpedFiles = true;
					}
					await commitAndTag(config, tag, newVersion, pstate.bumpedFiles);
					pstate.didCommit = true;
				}
				await runHook("postCommit", config.hooks.postCommit, hookCtx());
			}

			if (config.steps.push) {
				await runHook("prePush", config.hooks.prePush, hookCtx());
				if (isDryRun) {
					p.log.info(`${pc.dim("[dry-run]")} Would push to origin`);
				} else {
					pushedTags = await pushChanges(config, project.branch, tag, newVersion);
					pstate.didPush = true;
				}
				await runHook("postPush", config.hooks.postPush, hookCtx());
			}

			if (config.steps.githubRelease) {
				await runHook("preGithubRelease", config.hooks.preGithubRelease, hookCtx());
				if (isDryRun) {
					p.log.info(`${pc.dim("[dry-run]")} Would create GitHub release`);
				} else {
					await createGithubRelease(config, tag, changelog, isBeta);
				}
				await runHook("postGithubRelease", config.hooks.postGithubRelease, hookCtx());
			}

			prepared.push({ project, config, newVersion, tag, changelog, isBeta, pushedTags });
		} catch (err) {
			p.log.error(`${project.dirName}: ${errorText(err)}`);
			prepareFailures.push(project.dirName);

			const extraTags = config.git.extraTags
				.map((tpl) => tpl.replace(/\{tag\}/g, tag).replace(/\{version\}/g, newVersion))
				.filter((t) => t !== tag);
			const failure = classifyPipelineFailure(pstate);

			if (failure.partialStateWarning) {
				p.log.warn(`${project.dirName}: ${failure.partialStateWarning}`);
			}

			if (failure.canContinueToPublish) {
				prepared.push({ project, config, newVersion, tag, changelog, isBeta, pushedTags });
				p.log.info(`${project.dirName} will still proceed to npm publish`);
			} else if (failure.needsRollback) {
				// Same reasoning as the single-project path: a rollback rewrites
				// local history, so with no one to confirm it the partial state
				// is left alone and named instead of undone on a guess.
				const doRollback = isNonInteractive()
					? (p.log.warn(`${project.dirName}: not rolling back, no one to confirm it. Roll back by hand if you want the tag gone.`), false)
					: await p.confirm({
							message: `Roll back the partial release for ${project.dirName}?`,
							initialValue: true,
						});
				if (!p.isCancel(doRollback) && doRollback) {
					rollbackProjectRelease(config.root, tag, extraTags, pstate);
				}
			}

			if (isNonInteractive()) {
				p.log.warn("Continuing with the remaining projects. The batch will exit non-zero.");
			} else {
				const cont = await p.confirm({
					message: "Continue with remaining projects?",
					initialValue: true,
				});
				if (p.isCancel(cont) || !cont) break;
			}
		}
	}

	if (!prepared.length) {
		// A batch where every project threw is not "nothing to do" — the only
		// thing an unattended caller reads is the exit code (#74).
		if (prepareFailures.length) {
			process.exitCode = 1;
			p.outro(
				pc.red(`✗ Nothing was released: ${prepareFailures.length} project${prepareFailures.length === 1 ? "" : "s"} failed — ${prepareFailures.join(", ")}`),
			);
			console.log();
			return;
		}
		p.log.info("No projects to publish.");
		p.outro(pc.dim("Nothing to do."));
		console.log();
		return;
	}

	// Phase 2: Batch npm publish
	const npmProjects = prepared.filter((pp) => pp.config.steps.npm && pp.project.hasNpm);

	// Surface any prepared project that is about to skip npm publish despite
	// having steps.npm=true. A tag + GitHub release without an npm publish is
	// almost always a bug or a misconfiguration — never let it happen silently
	// (see LAC-2090).
	const skippedFromNpm = prepared.filter((pp) => pp.config.steps.npm && !pp.project.hasNpm);
	for (const pp of skippedFromNpm) {
		const reasons: string[] = [];
		for (const target of pp.config.npm.targets) {
			try {
				const pkg = readJson(resolve(target.cwd, "package.json"));
				// Delegate to isUnpublishablePackage so the reason string stays
				// in sync with detection (covers private, workspaces, AND
				// missing entry points — Gemini caught the entry-points gap on
				// PR #49).
				const reason = isUnpublishablePackage(pkg);
				if (reason) reasons.push(`${target.cwd}: ${reason}`);
			} catch {
				reasons.push(`${target.cwd}: package.json unreadable`);
			}
		}
		const reasonStr = reasons.length ? ` (${reasons.join("; ")})` : "";
		p.log.warn(
			`${pc.yellow(pp.project.dirName)} was tagged and pushed but will NOT be published to npm${reasonStr}.\n` +
			`  If this is unexpected, check ${pc.cyan("npm.cwd")} in ${pc.cyan(configFileLabel(pp.config))} or the package.json on this branch.`,
		);
	}

	/** Phase 2 outcome per project, read by the summary and the exit code. */
	let publishResults: { name: string; success: boolean }[] = [];
	/** Projects whose publish never ran because the auth prompt was cancelled. */
	let publishSkipped: string[] = [];

	if (npmProjects.length) {
		if (isDryRun) {
			p.log.step(pc.bold(`Phase 2: npm publish (${npmProjects.length} package${npmProjects.length === 1 ? "" : "s"})`));
			for (const pp of npmProjects) {
				const hCtx = { config: pp.config, version: pp.newVersion, tag: pp.tag, changelog: pp.changelog, isBeta: pp.isBeta };
				await runHook("preNpm", pp.config.hooks.preNpm, hCtx);
				p.log.info(`${pc.dim("[dry-run]")} Would publish ${pc.cyan(pp.project.dirName)}`);
				await runHook("postNpm", pp.config.hooks.postNpm, hCtx);
			}
		} else {
			p.log.step(pc.bold(`Phase 2: npm publish (${npmProjects.length} package${npmProjects.length === 1 ? "" : "s"})`));

			// A configured token is the only auth an unattended run can have, so
			// take that branch rather than open a select nobody can answer. This
			// prompt comes *after* phase 1 pushed every tag, so stalling here
			// leaves the whole batch half-shipped (#74). Same guard as
			// `publishMultipleTargets`.
			let authMethod: "web" | "otp" | "none" | null = null;
			if (isNonInteractive()) {
				p.log.info("Publishing with the configured npm token (non-interactive).");
				authMethod = "none";
			} else {
				const chosen = await p.select({
					message: "npm authentication method",
					options: buildNpmAuthOptions(npmProjects.length),
				});
				if (!p.isCancel(chosen)) authMethod = chosen;
			}

			if (authMethod === null) {
				// Cancelling here leaves every tag pushed with no package behind
				// it. It used to fall straight out of the `if` and the summary
				// still reported ✓ for each project (#74).
				publishSkipped = npmProjects.map((pp) => pp.project.dirName);
				p.log.warn(
					`npm publish cancelled — ${publishSkipped.map((n) => pc.yellow(n)).join(", ")} ${publishSkipped.length === 1 ? "is" : "are"} tagged with no package published.`,
				);
			} else {
				const webAuth = authMethod === "web";
				const results: { name: string; success: boolean }[] = [];

				for (const pp of npmProjects) {
					const hCtx = { config: pp.config, version: pp.newVersion, tag: pp.tag, changelog: pp.changelog, isBeta: pp.isBeta };
					await runHook("preNpm", pp.config.hooks.preNpm, hCtx);

					p.log.message(`  ${pc.cyan("→")} ${pp.project.dirName}`);
					let otp: string | undefined;
					if (authMethod === "otp") {
						const otpInput = await p.text({
							message: `npm OTP for ${pp.project.dirName}`,
							placeholder: "123456",
							validate: (v) => {
								if (!v || !/^\d{6}$/.test(v.trim())) return "OTP must be 6 digits";
							},
						});
						if (!p.isCancel(otpInput)) otp = otpInput.trim();
					}
					const success = await publishNpm(pp.config, pp.isBeta, { otp, webAuth, distTag: pp.config.tag || undefined });
					results.push({ name: pp.project.dirName, success });

					await runHook("postNpm", pp.config.hooks.postNpm, hCtx);
				}

				publishResults = results;
				const succeeded = results.filter((r) => r.success);
				const failed = results.filter((r) => !r.success);

				if (succeeded.length) {
					p.log.success(`Published: ${succeeded.map((r) => pc.green(r.name)).join(", ")}`);
				}
				if (failed.length) {
					p.log.warn(`Skipped/failed: ${failed.map((r) => pc.yellow(r.name)).join(", ")}`);
				}
			}
		}
	}

	// Phase 3: Homebrew (non-beta only)
	const brewProjects = prepared.filter((pp) => pp.config.steps.homebrew && !pp.isBeta);
	if (brewProjects.length) {
		if (isDryRun) {
			p.log.step(pc.bold("Phase 3: Homebrew"));
			for (const pp of brewProjects) {
				const hCtx = { config: pp.config, version: pp.newVersion, tag: pp.tag, changelog: pp.changelog, isBeta: pp.isBeta };
				await runHook("preHomebrew", pp.config.hooks.preHomebrew, hCtx);
				p.log.info(`${pc.dim("[dry-run]")} Would update Homebrew for ${pc.cyan(pp.project.dirName)}`);
				await runHook("postHomebrew", pp.config.hooks.postHomebrew, hCtx);
			}
		} else {
			p.log.step(pc.bold("Phase 3: Homebrew"));
			for (const pp of brewProjects) {
				const hCtx = { config: pp.config, version: pp.newVersion, tag: pp.tag, changelog: pp.changelog, isBeta: pp.isBeta };
				await runHook("preHomebrew", pp.config.hooks.preHomebrew, hCtx);
				p.log.message(`  ${pc.cyan("→")} ${pp.project.dirName}`);
				await publishHomebrew(pp.config, pp.tag, { skipConfirm: true });
				await runHook("postHomebrew", pp.config.hooks.postHomebrew, hCtx);
			}
		}
	}

	// Phase 4: watch delegated CI runs. A pushed tag is not the same as "CI
	// did the work" — check the runs each project's tags triggered (issue #62).
	const ciCandidates: BatchCiProject[] = prepared.map((pp) => ({
		dirName: pp.project.dirName,
		config: pp.config,
		pushedTags: pp.pushedTags,
	}));
	let ciResults: { name: string; result: CiWatchResult }[] = [];
	if (isDryRun) {
		for (const pp of ciEligibleProjects(ciCandidates)) {
			p.log.info(
				`${pc.dim("[dry-run]")} Would watch tag-triggered CI runs for ${pc.cyan(pp.dirName)}: ${ciDelegatedSteps(pp.config.steps).join(", ")}`,
			);
		}
	} else if (ciEligibleProjects(ciCandidates).some((pp) => pp.pushedTags.length)) {
		p.log.step(pc.bold("Phase 4: Delegated CI runs"));
		ciResults = await watchBatchCi(ciCandidates);
	}

	// Summary
	const verdict = summarizeBatch({
		prepared: prepared.map((pp) => ({ name: pp.project.dirName, tag: pp.tag })),
		prepareFailures,
		publishResults,
		publishSkipped,
		ci: ciResults,
		nonInteractive: isNonInteractive(),
	});
	if (verdict.failed) process.exitCode = 1;

	const dryRunPrefix = isDryRun ? `${pc.dim("[dry-run]")} Would release` : "Released";
	const summary = verdict.statuses
		.map(({ name, tag, status }) => {
			const tagLabel = tag ? ` ${pc.green(tag)}` : "";
			switch (status) {
				case "prepare-failed":
					return `${pc.red("✗")} ${name}${tagLabel} ${pc.red("— release step failed")}`;
				case "publish-failed":
					return `${pc.red("✗")} ${name}${tagLabel} ${pc.red("— npm publish failed, tag pushed with no package")}`;
				case "publish-skipped":
					return `${pc.yellow("⚠")} ${name}${tagLabel} ${pc.yellow("— npm publish skipped, tag pushed with no package")}`;
				case "ci-failed":
					return `${pc.red("✗")} ${name}${tagLabel} ${pc.red("— CI failed")}`;
				case "ci-missing":
					return `${pc.yellow("⚠")} ${name}${tagLabel} ${pc.yellow("— no CI run for tag")}`;
				case "ci-pending":
					return `${pc.yellow("⚠")} ${name}${tagLabel} ${pc.yellow("— CI still running")}`;
				default:
					return `${pc.green("✓")} ${name}${tagLabel}`;
			}
		})
		.join("\n  ");
	const count = `${pc.cyan(String(prepared.length))} project${prepared.length === 1 ? "" : "s"}`;
	const headline = verdict.problems.length
		? `${dryRunPrefix} ${count}, ${pc.red(verdict.problems.join("; "))}`
		: `${dryRunPrefix} ${count}`;
	p.outro(`${headline}:\n  ${summary}`);
	console.log();
}
