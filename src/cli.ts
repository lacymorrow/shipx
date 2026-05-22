#!/usr/bin/env node
import * as p from "@clack/prompts";
import pc from "picocolors";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.ts";
import { runHook } from "./hooks.ts";
import { multiMain } from "./multi.ts";
import { bumpCargoWorkspaces } from "./steps/cargo.ts";
import { bumpVersionFiles, getFilesToStage } from "./steps/bump.ts";
import { generateChangelog } from "./steps/changelog.ts";
import { runCleanup } from "./steps/cleanup.ts";
import { createGithubRelease } from "./steps/github.ts";
import { commitAndTag, pushChanges, PartialPushError, planRollback } from "./steps/git.ts";
import { publishHomebrew } from "./steps/homebrew.ts";
import { publishNpm } from "./steps/npm.ts";
import { runPreflight } from "./steps/preflight.ts";
import { runTests } from "./steps/test.ts";
import { pickVersion } from "./steps/version.ts";
import { reconcileRegistryVersion } from "./registry.ts";
import { exec, isGitRepo, parseFlag, readJson, setupCleanExit } from "./utils.ts";

export type { ShipConfig, BumpFileConfig, Hooks, HookFunction, HookContext, NpmTarget } from "./types.ts";

setupCleanExit();

function getVersion(): string {
	try {
		const pkg = readJson(fileURLToPath(new URL("../package.json", import.meta.url)));
		return (pkg.version as string) ?? "unknown";
	} catch {
		return "unknown";
	}
}

function printHelp(): void {
	const version = getVersion();
	console.log(`
${pc.bold("shipx")} ${pc.dim(`v${version}`)} — Interactive release CLI

${pc.bold("USAGE")}
  ${pc.green("shipx")} [command] [options]

${pc.bold("COMMANDS")}
  ${pc.cyan("patch")}              Bump patch version (x.y.Z)
  ${pc.cyan("minor")}              Bump minor version (x.Y.0)
  ${pc.cyan("major")}              Bump major version (X.0.0)
  ${pc.cyan("<semver>")}            Set an explicit version (e.g. 2.0.0)

  If no command is given, shipx prompts interactively.

${pc.bold("OPTIONS")}
  ${pc.yellow("--beta")}             Create a beta pre-release (-beta.N)
  ${pc.yellow("--draft")}            Create GitHub release as draft (review before publishing)
  ${pc.yellow("--dry-run")}          Preview all steps without executing
  ${pc.yellow("--tag <name>")}       Publish with a custom dist-tag (e.g. next, canary, rc)
  ${pc.yellow("--any-branch")}       Allow releasing from any branch, not just the release branch
  ${pc.yellow("--no-tests")}         Disable tests (overrides config steps.test=true)
  ${pc.yellow("--no-cleanup")}       Disable cleanup (overrides config steps.cleanup=true)
  ${pc.yellow("--multi")}            Batch deploy multiple projects from the parent directory
  ${pc.yellow("--help, -h")}         Show this help message
  ${pc.yellow("--version, -v")}      Print version

${pc.bold("ENVIRONMENT")}
  ${pc.yellow("SHIPX_ROOT")}         Override the project directory (default: cwd)

${pc.bold("CONFIG")}
  shipx looks for configuration in this order:
  1. shipx.config.ts / shipx.config.js
  2. .shipxrc.json / .shipxrc
  3. "shipx" key in package.json
  4. Defaults (auto-detects package.json, Cargo.toml, homebrew-tap)

${pc.dim("https://github.com/lacymorrow/shipx")}
`);
}

function rollbackRelease(
	root: string,
	tag: string,
	extraTags: string[],
	pushedTags: string[],
	opts: { preReleaseSha: string; commitWasMade: boolean; branchPushed?: boolean },
): void {
	p.log.warn("Rolling back release…");

	const allTags = [tag, ...extraTags];
	const plan = planRollback(allTags, pushedTags, opts.branchPushed);

	for (const t of plan.localTagsToDelete) {
		try {
			exec("git", ["tag", "-d", t], { cwd: root });
		} catch {
			// tag may not exist
		}
	}

	if (opts.commitWasMade) {
		const currentSha = exec("git", ["rev-parse", "HEAD"], { cwd: root }).trim();
		const commitSubject = exec("git", ["log", "-1", "--format=%s", "HEAD"], { cwd: root }).trim();
		const looksLikeRelease = commitSubject.includes(tag.replace(/^v/, "")) || commitSubject.includes(tag);

		if (!looksLikeRelease) {
			p.log.error(
				`HEAD (${currentSha.slice(0, 8)}) does not look like the release commit.\n` +
				`  Subject: "${commitSubject}"\n` +
				`  Expected it to reference "${tag}".\n` +
				`  Manual cleanup required (verify before running): git reset --soft ${opts.preReleaseSha}`,
			);
			return;
		}

		let parentSha = "";
		try {
			parentSha = exec("git", ["rev-parse", "HEAD^"], { cwd: root }).trim();
		} catch {
			p.log.error(
				`HEAD (${currentSha.slice(0, 8)}) has no parent commit. Refusing to reset; clean up manually.`,
			);
			return;
		}

		if (parentSha !== opts.preReleaseSha) {
			p.log.error(
				`HEAD's parent (${parentSha.slice(0, 8)}) is not the pre-release commit (${opts.preReleaseSha.slice(0, 8)}).\n` +
				`  History was rewritten between commitAndTag and rollback (likely a pull --rebase during push).\n` +
				`  Resetting to the captured SHA would discard upstream commits. Refusing to reset.\n` +
				`  Manual cleanup: review with ${pc.green("git log --oneline -5")} then ${pc.green(`git reset --soft ${parentSha}`)} if appropriate.`,
			);
			return;
		}

		try {
			exec("git", ["reset", "--soft", opts.preReleaseSha], { cwd: root });
			p.log.info("Rolled back locally: removed tag(s) and undid release commit");
		} catch {
			p.log.error(`Failed to reset to ${opts.preReleaseSha} — you may need to clean up manually`);
			return;
		}
	} else {
		p.log.info("Rolled back locally: removed tag(s) (no release commit to undo)");
	}

	if (plan.branchPushed || plan.remoteTagsToDelete.length > 0) {
		p.log.warn("Some artifacts were already pushed to remote. Clean up manually:");
		for (const t of plan.remoteTagsToDelete) {
			p.log.message(`  ${pc.dim(`git push origin :refs/tags/${t}`)}`);
		}
		if (plan.branchPushed && opts.commitWasMade) {
			p.log.message(`  ${pc.dim("git push --force-with-lease origin HEAD")}`);
		}
	}
}

async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
	if (argv.includes("--help") || argv.includes("-h")) {
		printHelp();
		return;
	}

	if (argv.includes("--version") || argv.includes("-v")) {
		console.log(getVersion());
		return;
	}

	if (argv.includes("--multi")) {
		return multiMain(argv.filter((a) => a !== "--multi"));
	}

	const isBeta = argv.includes("--beta");
	const isDraft = argv.includes("--draft");
	const isDryRun = argv.includes("--dry-run");
	const isAnyBranch = argv.includes("--any-branch");
	const noTests = argv.includes("--no-tests");
	const noCleanup = argv.includes("--no-cleanup");
	const customTag = parseFlag(argv, "--tag");
	if (argv.includes("--tag") && !customTag) {
		p.log.error("--tag requires a value (e.g. --tag next)");
		process.exit(1);
	}

	const filteredFlags = ["--beta", "--draft", "--dry-run", "--any-branch", "--no-tests", "--no-cleanup"];
	let args = argv.filter((a) => !filteredFlags.includes(a));
	if (customTag) {
		const tagIdx = args.indexOf("--tag");
		if (tagIdx !== -1) args.splice(tagIdx, 2);
	}

	const root = process.env.SHIPX_ROOT ?? process.cwd();
	const config = await loadConfig(root);

	if (isDraft) config.github.draft = true;
	if (isDryRun) config.dryRun = true;
	if (isAnyBranch) config.anyBranch = true;
	if (customTag) config.tag = customTag;
	if (noTests) config.steps.test = false;
	if (noCleanup) config.steps.cleanup = false;

	const pkgJsonPaths = config.packageJsonPaths.map((rel) =>
		resolve(root, rel),
	);
	if (!pkgJsonPaths.length) {
		p.log.error("No packageJsonPaths configured. Add them to shipx.config.ts or package.json.");
		process.exit(1);
	}

	const rootPkg = readJson(pkgJsonPaths[0]);
	const currentVersion = rootPkg.version as string;
	if (!currentVersion) {
		p.log.error(`No version found in ${pc.cyan(pkgJsonPaths[0])}`);
		process.exit(1);
	}

	let projectName = "shipx";
	if (typeof rootPkg.name === "string") {
		projectName = rootPkg.name.replace(/^@[^/]+\//, "");
	}

	if (!isGitRepo(root)) {
		p.log.error(
			`${pc.cyan(root)} is not a git repository.\n` +
			`  Run ${pc.green("shipx")} from inside a project, or use ${pc.green("shipx --multi")} to deploy multiple projects from a parent directory.`,
		);
		process.exit(1);
	}

	if (process.stdout.isTTY) {
		console.clear();
	}

	const modeLabel = [
		isBeta ? "Beta" : null,
		isDryRun ? "Dry Run" : null,
	].filter(Boolean).join(" · ");
	const subtitle = modeLabel ? ` — ${modeLabel}` : "";

	p.intro(
		pc.magenta(
			pc.bold(`  ${projectName} — Release${subtitle}  `),
		),
	);

	if (isDryRun) {
		p.log.info(pc.dim("Dry-run mode — no changes will be made"));
	}

	const hookCtx = () => ({ config, version: newVersion, tag: gitTag, changelog, isBeta });
	let newVersion = "";
	let gitTag = "";
	let changelog = `- Release (pending)`;

	let branch = "main";
	if (config.steps.preflight) {
		await runHook("prePreflight", config.hooks.prePreflight, hookCtx());
		branch = runPreflight(config, isBeta);
		await runHook("postPreflight", config.hooks.postPreflight, hookCtx());
	}

	if (config.steps.cleanup) {
		await runHook("preCleanup", config.hooks.preCleanup, hookCtx());
		runCleanup(config);
		await runHook("postCleanup", config.hooks.postCleanup, hookCtx());
	}

	if (config.steps.test) {
		await runHook("preTest", config.hooks.preTest, hookCtx());
		runTests(config);
		await runHook("postTest", config.hooks.postTest, hookCtx());
	}

	let baseVersion = currentVersion;
	const isPrivate = rootPkg.private === true;
	if (config.steps.npm && !isPrivate && typeof rootPkg.name === "string") {
		if (isDryRun) {
			p.log.info(`${pc.dim("[dry-run]")} Would check npm registry for ${pc.cyan(projectName)}`);
		} else {
			baseVersion = await reconcileRegistryVersion(
				rootPkg.name,
				currentVersion,
				config.npm.cwd,
				{ displayName: projectName },
			);
		}
	}

	newVersion = await pickVersion(baseVersion, args[0], isBeta);
	gitTag = `${config.git.tagPrefix}${newVersion}`;
	changelog = `- Release ${gitTag}`;

	const distTag = customTag ?? (isBeta ? "beta" : "latest");
	const distTagDisplay = distTag !== "latest" ? ` (dist-tag: ${pc.yellow(distTag)})` : "";

	const proceed = await p.confirm({
		message: `Release ${pc.cyan(baseVersion)} → ${pc.green(newVersion)} (${gitTag})${distTagDisplay}?`,
	});
	if (p.isCancel(proceed) || !proceed) {
		p.cancel("Release cancelled.");
		process.exit(0);
	}

	let cargoStageDirs: string[] = [];
	if (config.steps.bumpVersion) {
		await runHook("preBump", config.hooks.preBump, hookCtx());
		if (isDryRun) {
			const files = [...config.packageJsonPaths, ...config.bumpFiles.map((f) => f.path)];
			p.log.info(`${pc.dim("[dry-run]")} Would bump version in: ${files.map((f) => pc.cyan(f)).join(", ")}`);
			if (config.cargoWorkspaces.length) {
				p.log.info(`${pc.dim("[dry-run]")} Would bump Cargo workspaces: ${config.cargoWorkspaces.map((d) => pc.cyan(d)).join(", ")}`);
			}
		} else {
			bumpVersionFiles(config, newVersion);
			cargoStageDirs = bumpCargoWorkspaces(config, newVersion);
		}
		await runHook("postBump", config.hooks.postBump, hookCtx());
	}

	if (config.steps.changelog) {
		await runHook("preChangelog", config.hooks.preChangelog, hookCtx());
		if (isDryRun) {
			p.log.info(`${pc.dim("[dry-run]")} Would generate changelog from commits since last tag`);
		} else {
			changelog = generateChangelog(config, gitTag);
		}
		await runHook("postChangelog", config.hooks.postChangelog, hookCtx());
	}

	const extraTags = config.git.extraTags
		.map((tpl) => tpl.replace(/\{tag\}/g, gitTag).replace(/\{version\}/g, newVersion))
		.filter((t) => t !== gitTag);

	const preReleaseSha = exec("git", ["rev-parse", "HEAD"], { cwd: root }).trim();
	let commitWasMade = false;

	if (config.steps.commit || config.steps.tag) {
		await runHook("preCommit", config.hooks.preCommit, hookCtx());
		if (isDryRun) {
			const allTags = [gitTag, ...extraTags].map((t) => pc.green(t)).join(", ");
			p.log.info(`${pc.dim("[dry-run]")} Would commit and tag: ${allTags}`);
		} else {
			const filesToStage = [...getFilesToStage(config), ...cargoStageDirs];
			commitAndTag(config, gitTag, newVersion, filesToStage);
			commitWasMade = config.steps.commit;
		}
		await runHook("postCommit", config.hooks.postCommit, hookCtx());
	}

	let pushedTags: string[] = [];
	if (config.steps.push) {
		await runHook("prePush", config.hooks.prePush, hookCtx());
		if (isDryRun) {
			p.log.info(`${pc.dim("[dry-run]")} Would push branch ${pc.cyan(branch)} and tag(s) to origin`);
		} else {
			try {
				pushedTags = await pushChanges(config, branch, gitTag, newVersion);
			} catch (err) {
				if (err instanceof PartialPushError) {
					p.log.error(`Tag push partially failed: ${err.message}`);
					p.log.warn(`Tags already pushed to remote: ${err.pushedTags.length ? err.pushedTags.map((t) => pc.green(t)).join(", ") : "none"}`);
					const doRollback = await p.confirm({
						message: "Roll back the release commit and tag(s)?",
						initialValue: true,
					});
					if (!p.isCancel(doRollback) && doRollback) {
						rollbackRelease(root, gitTag, extraTags, err.pushedTags, {
							preReleaseSha,
							commitWasMade,
							branchPushed: err.branchPushed,
						});
						await runHook("postPush", config.hooks.postPush, hookCtx());
						p.outro(pc.yellow("Release rolled back."));
						return;
					}
					p.log.warn("Continuing without rollback — orphan tags may exist on remote.");
					pushedTags = err.pushedTags;
				} else {
					throw err;
				}
			}

			if (extraTags.length) {
				p.log.info(`Tags: ${[gitTag, ...extraTags].map((t) => pc.green(t)).join(", ")}`);
			}

			const ciHandled: string[] = [];
			if (!config.steps.githubRelease) ciHandled.push("GitHub Release");
			if (!config.steps.homebrew) ciHandled.push("Homebrew");
			if (ciHandled.length) {
				p.log.info(`CI-handled (via tag push): ${ciHandled.join(", ")}`);
			}
		}
		await runHook("postPush", config.hooks.postPush, hookCtx());
	}

	if (config.steps.githubRelease) {
		await runHook("preGithubRelease", config.hooks.preGithubRelease, hookCtx());
		if (isDryRun) {
			const draftLabel = config.github.draft ? " (draft)" : "";
			const assetLabel = config.github.assets.length
				? ` with assets: ${config.github.assets.map((a) => pc.cyan(a)).join(", ")}`
				: "";
			p.log.info(`${pc.dim("[dry-run]")} Would create GitHub release for ${pc.green(gitTag)}${draftLabel}${assetLabel}`);
		} else {
			createGithubRelease(config, gitTag, changelog, isBeta);
		}
		await runHook("postGithubRelease", config.hooks.postGithubRelease, hookCtx());
	}

	if (config.steps.npm) {
		await runHook("preNpm", config.hooks.preNpm, hookCtx());
		if (isDryRun) {
			if (config.npm.targets.length > 1) {
				p.log.info(`${pc.dim("[dry-run]")} Would publish ${pc.cyan(String(config.npm.targets.length))} npm targets with tag=${distTag}`);
				for (const target of config.npm.targets) {
					p.log.message(`  ${pc.dim("→")} ${pc.cyan(target.cwd)} (access=${target.access})`);
				}
			} else {
				p.log.info(`${pc.dim("[dry-run]")} Would publish to npm with access=${config.npm.targets[0].access}, tag=${distTag}`);
			}
		} else {
			const published = await publishNpm(config, isBeta, { distTag: customTag });
			if (!published && (config.steps.commit || config.steps.tag)) {
				const doRollback = await p.confirm({
					message: "npm publish failed. Roll back the release commit and tag?",
					initialValue: true,
				});
				if (!p.isCancel(doRollback) && doRollback) {
					rollbackRelease(root, gitTag, extraTags, pushedTags, { preReleaseSha, commitWasMade });
					await runHook("postNpm", config.hooks.postNpm, hookCtx());
					p.outro(pc.yellow("Release rolled back."));
					return;
				}
			}
		}
		await runHook("postNpm", config.hooks.postNpm, hookCtx());
	}

	if (config.steps.homebrew && !isBeta) {
		await runHook("preHomebrew", config.hooks.preHomebrew, hookCtx());
		if (isDryRun) {
			const brewMode = Object.keys(config.homebrew.binaryAssets).length > 0 ? "binary" : "source";
			p.log.info(`${pc.dim("[dry-run]")} Would update Homebrew formula (${brewMode} mode)`);
		} else {
			await publishHomebrew(config, gitTag);
		}
		await runHook("postHomebrew", config.hooks.postHomebrew, hookCtx());
	} else if (isBeta && config.steps.homebrew) {
		p.log.info("Skipping Homebrew for beta release");
	}

	let releaseUrl = `${gitTag}`;
	try {
		const remote = exec("git", ["remote", "get-url", "origin"], { cwd: root }).trim();
		const match = remote.match(/github\.com[:/]([^/]+\/[^/.]+)/);
		if (match) {
			const slug = match[1].replace(/\.git$/, "");
			releaseUrl = `https://github.com/${slug}/releases/tag/${gitTag}`;
		}
	} catch {
		// no remote
	}

	if (isDryRun) {
		p.outro(`${pc.dim("[dry-run]")} Would release ${pc.green(gitTag)} — no changes were made`);
	} else {
		p.outro(
			`${pc.green("✓")} Released ${pc.green(gitTag)} — ${pc.cyan(releaseUrl)}`,
		);
	}
}

main().catch((err) => {
	console.error(err?.message ?? err);
	process.exit(1);
});
