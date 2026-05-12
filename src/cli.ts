#!/usr/bin/env node
import * as p from "@clack/prompts";
import pc from "picocolors";
import { resolve } from "node:path";
import { loadConfig } from "./config.ts";
import { bumpCargoWorkspaces } from "./steps/cargo.ts";
import { bumpVersionFiles, getFilesToStage } from "./steps/bump.ts";
import { generateChangelog } from "./steps/changelog.ts";
import { createGithubRelease } from "./steps/github.ts";
import { commitAndTag, pushChanges } from "./steps/git.ts";
import { publishHomebrew } from "./steps/homebrew.ts";
import { publishNpm } from "./steps/npm.ts";
import { runPreflight } from "./steps/preflight.ts";
import { pickVersion } from "./steps/version.ts";
import { exec, readJson } from "./utils.ts";

export type { ShipConfig, BumpFileConfig } from "./types.ts";

async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
	const isBeta = argv.includes("--beta");
	const args = argv.filter((a) => a !== "--beta");

	const root = process.env.SHIPX_ROOT ?? process.cwd();
	const config = await loadConfig(root);

	const pkgJsonPaths = config.packageJsonPaths.map((rel) =>
		resolve(root, rel),
	);
	if (!pkgJsonPaths.length) {
		p.log.error("No packageJsonPaths configured. Add them to shipx.config.ts or package.json.");
		process.exit(1);
	}

	const rootPkg = readJson(pkgJsonPaths[0]);
	const currentVersion = rootPkg.version as string;

	// Use the package name from package.json, stripping any npm scope prefix
	let projectName = "shipx";
	if (rootPkg.name) {
		projectName = (rootPkg.name as string).replace(/^@[^/]+\//, "");
	}

	if (process.stdout.isTTY) {
		console.clear();
	}
	p.intro(
		pc.magenta(
			pc.bold(isBeta ? `  ${projectName} — Beta Release  ` : `  ${projectName} — Release  `),
		),
	);

	let branch = "main";
	if (config.steps.preflight) {
		branch = runPreflight(config, isBeta);
	}

	const newVersion = await pickVersion(currentVersion, args[0], isBeta);
	const tag = `${config.git.tagPrefix}${newVersion}`;

	const proceed = await p.confirm({
		message: `Release ${pc.cyan(currentVersion)} → ${pc.green(newVersion)} (${tag})?`,
	});
	if (p.isCancel(proceed) || !proceed) {
		p.cancel("Release cancelled.");
		process.exit(0);
	}

	// Bump package.json files
	if (config.steps.bumpVersion) {
		bumpVersionFiles(config, newVersion);
	}

	// Bump Cargo.toml files (Tauri / Rust workspaces)
	const cargoStageDirs = bumpCargoWorkspaces(config, newVersion);

	let changelog = `- Release ${tag}`;
	if (config.steps.changelog) {
		changelog = generateChangelog(config, tag);
	}

	if (config.steps.commit || config.steps.tag) {
		const filesToStage = [...getFilesToStage(config), ...cargoStageDirs];
		commitAndTag(config, tag, newVersion, filesToStage);
	}

	if (config.steps.push) {
		pushChanges(config, branch, tag, newVersion);
	}

	if (config.steps.githubRelease) {
		createGithubRelease(config, tag, changelog, isBeta);
	}

	if (config.steps.npm) {
		await publishNpm(config, isBeta);
	}

	if (config.steps.homebrew && !isBeta) {
		await publishHomebrew(config, tag);
	} else if (isBeta && config.steps.homebrew) {
		p.log.info("Skipping Homebrew for beta release");
	}

	let releaseUrl = `${tag}`;
	try {
		const remote = exec("git", ["remote", "get-url", "origin"], { cwd: root }).trim();
		const match = remote.match(/github\.com[:/]([^/]+\/[^/.]+)/);
		if (match) {
			const slug = match[1].replace(/\.git$/, "");
			releaseUrl = `https://github.com/${slug}/releases/tag/${tag}`;
		}
	} catch {
		// no remote
	}

	p.outro(
		`${pc.green("✓")} Released ${pc.green(tag)} — ${pc.cyan(releaseUrl)}`,
	);
}

main().catch((err) => {
	console.error(err?.message ?? err);
	process.exit(1);
});
