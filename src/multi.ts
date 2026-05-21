import * as p from "@clack/prompts";
import pc from "picocolors";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig } from "./config.ts";
import { discoverProjects, type DiscoveredProject, type DiscoverResult } from "./discover.ts";
import { bumpCargoWorkspaces } from "./steps/cargo.ts";
import { bumpVersionFiles, getFilesToStage } from "./steps/bump.ts";
import { generateChangelog } from "./steps/changelog.ts";
import { createGithubRelease } from "./steps/github.ts";
import { commitAndTag, pushChanges } from "./steps/git.ts";
import { publishHomebrew } from "./steps/homebrew.ts";
import { publishNpm } from "./steps/npm.ts";
import { pickVersion } from "./steps/version.ts";
import { branchExists, errorText, exec, setupCleanExit } from "./utils.ts";
import type { ResolvedConfig } from "./types.ts";

setupCleanExit();

function loadIgnored(root: string): Set<string> {
	const ignorePath = resolve(root, ".shipxignore");
	if (!existsSync(ignorePath)) return new Set();
	return new Set(
		readFileSync(ignorePath, "utf-8")
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line && !line.startsWith("#")),
	);
}

function saveIgnored(root: string, ignored: Set<string>): void {
	const ignorePath = resolve(root, ".shipxignore");
	const content = [...ignored].sort().join("\n") + "\n";
	writeFileSync(ignorePath, content);
}

interface PreparedProject {
	project: DiscoveredProject;
	config: ResolvedConfig;
	newVersion: string;
	tag: string;
	changelog: string;
	isBeta: boolean;
}

export async function multiMain(argv: string[]): Promise<void> {
	const isBeta = argv.includes("--beta");
	const isDraft = argv.includes("--draft");
	const root = process.env.SHIPX_ROOT ?? process.cwd();

	if (process.stdout.isTTY) {
		console.clear();
	}
	p.intro(pc.magenta(pc.bold("  shipx — Multi-Project Deploy  ")));

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

	const newIgnored = new Set<string>();
	for (const proj of projects) {
		if (!selectedPaths.includes(proj.path)) {
			newIgnored.add(proj.dirName);
		}
	}
	saveIgnored(root, newIgnored);
	const selectedProjects = projects.filter((proj) => selectedPaths.includes(proj.path));

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
		if (isDraft) {
			config.github.draft = true;
		}

		if (!isBeta && project.branch !== config.git.releaseBranch) {
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

		const versionArg = bumpMode === "individual" ? undefined : bumpMode;
		const newVersion = await pickVersion(project.version, versionArg, isBeta);
		const tag = `${config.git.tagPrefix}${newVersion}`;

		const proceed = await p.confirm({
			message: `${project.dirName}: ${pc.cyan(project.version)} → ${pc.green(newVersion)} (${tag})?`,
		});
		if (p.isCancel(proceed) || !proceed) {
			p.log.info(`Skipping ${project.dirName}`);
			continue;
		}

		try {
			let cargoStageDirs: string[] = [];
			if (config.steps.bumpVersion) {
				bumpVersionFiles(config, newVersion);
				cargoStageDirs = bumpCargoWorkspaces(config, newVersion);
			}

			let changelog = `- Release ${tag}`;
			if (config.steps.changelog) {
				changelog = generateChangelog(config, tag);
			}

			if (config.steps.commit || config.steps.tag) {
				const filesToStage = [...getFilesToStage(config), ...cargoStageDirs];
				commitAndTag(config, tag, newVersion, filesToStage);
			}

			if (config.steps.push) {
				await pushChanges(config, project.branch, tag, newVersion);
			}

			if (config.steps.githubRelease) {
				createGithubRelease(config, tag, changelog, isBeta);
			}

			prepared.push({ project, config, newVersion, tag, changelog, isBeta });
		} catch (err) {
			p.log.error(`${project.dirName}: ${errorText(err)}`);
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
		p.log.step(pc.bold(`Phase 2: npm publish (${npmProjects.length} package${npmProjects.length === 1 ? "" : "s"})`));

		const authMethod = await p.select({
			message: "npm authentication method",
			options: [
				{ value: "web" as const, label: "Web auth (passkey)", hint: "authenticate in browser" },
				{ value: "otp" as const, label: "Enter OTP code", hint: "reuse one OTP for all packages" },
				{ value: "none" as const, label: "No auth needed", hint: "token already configured" },
			],
		});

		if (!p.isCancel(authMethod)) {
			let otp: string | undefined;
			const webAuth = authMethod === "web";

			if (authMethod === "otp") {
				if (npmProjects.length > 1) {
					p.log.info(
						`Publishing ${pc.cyan(String(npmProjects.length))} packages. ` +
						`Enter your OTP once — it'll be reused for all publishes.`,
					);
				}
				const otpInput = await p.text({
					message: "npm OTP (will be used for all packages)",
					placeholder: "123456",
					validate: (v) => {
						if (!v || !/^\d{6}$/.test(v.trim())) return "OTP must be 6 digits";
					},
				});
				if (!p.isCancel(otpInput)) {
					otp = otpInput.trim();
				}
			}

			const results: { name: string; success: boolean }[] = [];

			for (const pp of npmProjects) {
				p.log.message(`  ${pc.cyan("→")} ${pp.project.dirName}`);
				const success = await publishNpm(pp.config, pp.isBeta, { otp, webAuth });
				if (!success && otp) otp = undefined;
				results.push({ name: pp.project.dirName, success });
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

	// Phase 3: Homebrew (non-beta only)
	const brewProjects = prepared.filter((pp) => pp.config.steps.homebrew && !pp.isBeta);
	if (brewProjects.length) {
		p.log.step(pc.bold("Phase 3: Homebrew"));
		for (const pp of brewProjects) {
			p.log.message(`  ${pc.cyan("→")} ${pp.project.dirName}`);
			await publishHomebrew(pp.config, pp.tag, { skipConfirm: true });
		}
	}

	// Summary
	const summary = prepared
		.map((pp) => `${pc.green("✓")} ${pp.project.dirName} ${pc.green(pp.tag)}`)
		.join("\n  ");
	p.outro(`Released ${pc.cyan(String(prepared.length))} project${prepared.length === 1 ? "" : "s"}:\n  ${summary}`);
}
