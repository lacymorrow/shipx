#!/usr/bin/env node
import * as p from "@clack/prompts";
import pc from "picocolors";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.ts";
import { multiMain } from "./multi.ts";
import { bumpCargoWorkspaces } from "./steps/cargo.ts";
import { bumpVersionFiles, getFilesToStage } from "./steps/bump.ts";
import { generateChangelog } from "./steps/changelog.ts";
import { createGithubRelease } from "./steps/github.ts";
import { commitAndTag, pushChanges } from "./steps/git.ts";
import { publishHomebrew } from "./steps/homebrew.ts";
import { publishNpm } from "./steps/npm.ts";
import { runPreflight } from "./steps/preflight.ts";
import { pickVersion } from "./steps/version.ts";
import { exec, isGitRepo, readJson } from "./utils.ts";

export type { ShipConfig, BumpFileConfig } from "./types.ts";

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
	if (!currentVersion) {
		p.log.error(`No version found in ${pc.cyan(pkgJsonPaths[0])}`);
		process.exit(1);
	}

	// Use the package name from package.json, stripping any npm scope prefix
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

	// Bump package.json and Cargo.toml files
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
