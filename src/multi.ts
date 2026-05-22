import * as p from "@clack/prompts";
import pc from "picocolors";
import { resolve } from "node:path";
import { loadConfig } from "./config.ts";
import { runHook } from "./hooks.ts";
import { discoverProjects, type DiscoveredProject, type DiscoverResult } from "./discover.ts";
import { computeIgnoredAfterSelection, loadIgnored, saveIgnored } from "./ignore.ts";
import { bumpCargoWorkspaces } from "./steps/cargo.ts";
import { bumpVersionFiles, getFilesToStage } from "./steps/bump.ts";
import { generateChangelog } from "./steps/changelog.ts";
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
}

function parseFlag(argv: string[], flag: string): string | undefined {
	const idx = argv.indexOf(flag);
	if (idx === -1 || idx === argv.length - 1) return undefined;
	return argv[idx + 1];
}

export async function multiMain(argv: string[]): Promise<void> {
	const isBeta = argv.includes("--beta");
	const isDraft = argv.includes("--draft");
	const isDryRun = argv.includes("--dry-run");
	const isAnyBranch = argv.includes("--any-branch");
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
			const npmFlag = proj.hasNpm ? "" : pc.dim(" (private)");
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
		return;
	}

	const preSelected = withChanges
		.filter((proj) => !proj.archived && !ignored.has(proj.dirName))
		.map((proj) => proj.path);

	const selected = await p.multiselect({
		message: "Select projects to release",
		options,
		initialValues: preSelected,
		required: true,
	});

	if (p.isCancel(selected)) {
		p.cancel("Release cancelled.");
		process.exit(0);
	}

	const selectedPaths = selected as string[];
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
		const proceed = await p.confirm({
			message: "Continue anyway? (dirty projects will fail preflight)",
			initialValue: false,
		});
		if (p.isCancel(proceed) || !proceed) {
			p.cancel("Release cancelled.");
			process.exit(0);
		}
	}

	const bumpMode = await p.select({
		message: "Version bump strategy",
		options: [
			{ value: "individual" as const, label: "Pick per project", hint: "choose bump type for each" },
			{ value: "patch" as const, label: "Patch all", hint: "bump all selected as patch" },
			{ value: "minor" as const, label: "Minor all", hint: "bump all selected as minor" },
			{ value: "major" as const, label: "Major all", hint: "bump all selected as major" },
		],
	});

	if (p.isCancel(bumpMode)) {
		p.cancel("Release cancelled.");
		process.exit(0);
	}

	// Phase 1: Prepare all projects (version, bump, commit, tag, push)
	p.log.step(pc.bold("Phase 1: Prepare releases"));
	const prepared: PreparedProject[] = [];

	for (const project of selectedProjects) {
		p.log.step(`${pc.cyan(project.dirName)} ${pc.dim(`(${project.version})`)}`);

		const config = await loadConfig(project.path);
		if (isDraft) config.github.draft = true;
		if (isDryRun) config.dryRun = true;
		if (isAnyBranch) config.anyBranch = true;
		if (customTag) config.tag = customTag;

		if (!isBeta && !isAnyBranch && project.branch !== config.git.releaseBranch) {
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

		const proceed = await p.confirm({
			message: `${project.dirName}: ${pc.cyan(baseVersion)} → ${pc.green(newVersion)} (${tag})?`,
		});
		if (p.isCancel(proceed) || !proceed) {
			p.log.info(`Skipping ${project.dirName}`);
			continue;
		}

		const pstate: PipelineState = {
			didBump: false,
			didCommit: false,
			didPush: false,
			didComputeBumpedFiles: false,
			bumpedFiles: [],
		};
		let changelog = `- Release ${tag}`;
		const hookCtx = () => ({ config, version: newVersion, tag, changelog, isBeta });
		try {
			let cargoStageDirs: string[] = [];
			if (config.steps.bumpVersion) {
				await runHook("preBump", config.hooks.preBump, hookCtx());
				if (isDryRun) {
					const files = [...config.packageJsonPaths, ...config.bumpFiles.map((f: { path: string }) => f.path)];
					p.log.info(`${pc.dim("[dry-run]")} Would bump: ${files.map((f: string) => pc.cyan(f)).join(", ")}`);
				} else {
					bumpVersionFiles(config, newVersion);
					cargoStageDirs = bumpCargoWorkspaces(config, newVersion);
					pstate.didBump = true;
					pstate.bumpedFiles = [...getFilesToStage(config), ...cargoStageDirs];
					pstate.didComputeBumpedFiles = true;
				}
				await runHook("postBump", config.hooks.postBump, hookCtx());
			}

			if (config.steps.changelog) {
				await runHook("preChangelog", config.hooks.preChangelog, hookCtx());
				if (isDryRun) {
					p.log.info(`${pc.dim("[dry-run]")} Would generate changelog`);
				} else {
					changelog = generateChangelog(config, tag);
				}
				await runHook("postChangelog", config.hooks.postChangelog, hookCtx());
			}

			if (config.steps.commit || config.steps.tag) {
				await runHook("preCommit", config.hooks.preCommit, hookCtx());
				if (isDryRun) {
					p.log.info(`${pc.dim("[dry-run]")} Would commit and tag ${pc.green(tag)}`);
				} else {
					if (!pstate.didComputeBumpedFiles) {
						pstate.bumpedFiles = [...getFilesToStage(config), ...cargoStageDirs];
						pstate.didComputeBumpedFiles = true;
					}
					commitAndTag(config, tag, newVersion, pstate.bumpedFiles);
					pstate.didCommit = true;
				}
				await runHook("postCommit", config.hooks.postCommit, hookCtx());
			}

			if (config.steps.push) {
				await runHook("prePush", config.hooks.prePush, hookCtx());
				if (isDryRun) {
					p.log.info(`${pc.dim("[dry-run]")} Would push to origin`);
				} else {
					await pushChanges(config, project.branch, tag, newVersion);
					pstate.didPush = true;
				}
				await runHook("postPush", config.hooks.postPush, hookCtx());
			}

			if (config.steps.githubRelease) {
				await runHook("preGithubRelease", config.hooks.preGithubRelease, hookCtx());
				if (isDryRun) {
					p.log.info(`${pc.dim("[dry-run]")} Would create GitHub release`);
				} else {
					createGithubRelease(config, tag, changelog, isBeta);
				}
				await runHook("postGithubRelease", config.hooks.postGithubRelease, hookCtx());
			}

			prepared.push({ project, config, newVersion, tag, changelog, isBeta });
		} catch (err) {
			p.log.error(`${project.dirName}: ${errorText(err)}`);

			const extraTags = config.git.extraTags
				.map((tpl) => tpl.replace(/\{tag\}/g, tag).replace(/\{version\}/g, newVersion))
				.filter((t) => t !== tag);
			const failure = classifyPipelineFailure(pstate);

			if (failure.partialStateWarning) {
				p.log.warn(`${project.dirName}: ${failure.partialStateWarning}`);
			}

			if (failure.canContinueToPublish) {
				prepared.push({ project, config, newVersion, tag, changelog, isBeta });
				p.log.info(`${project.dirName} will still proceed to npm publish`);
			} else if (failure.needsRollback) {
				const doRollback = await p.confirm({
					message: `Roll back the partial release for ${project.dirName}?`,
					initialValue: true,
				});
				if (!p.isCancel(doRollback) && doRollback) {
					rollbackProjectRelease(config.root, tag, extraTags, pstate);
				}
			}

			const cont = await p.confirm({
				message: "Continue with remaining projects?",
				initialValue: true,
			});
			if (p.isCancel(cont) || !cont) break;
		}
	}

	if (!prepared.length) {
		p.log.info("No projects to publish.");
		p.outro(pc.dim("Nothing to do."));
		return;
	}

	// Phase 2: Batch npm publish
	const npmProjects = prepared.filter((pp) => pp.config.steps.npm && pp.project.hasNpm);

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

			const authOptions = buildNpmAuthOptions(npmProjects.length);
			const authMethod = await p.select({
				message: "npm authentication method",
				options: authOptions,
			});

			if (!p.isCancel(authMethod)) {
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

	// Summary
	const dryRunPrefix = isDryRun ? `${pc.dim("[dry-run]")} Would release` : "Released";
	const summary = prepared
		.map((pp) => `${pc.green("✓")} ${pp.project.dirName} ${pc.green(pp.tag)}`)
		.join("\n  ");
	p.outro(`${dryRunPrefix} ${pc.cyan(String(prepared.length))} project${prepared.length === 1 ? "" : "s"}:\n  ${summary}`);
}
