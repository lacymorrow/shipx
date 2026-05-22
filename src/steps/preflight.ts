import * as p from "@clack/prompts";
import pc from "picocolors";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { ResolvedConfig } from "../types.ts";
import { exec, isRepoArchived, readJson } from "../utils.ts";

function checkCleanTree(config: ResolvedConfig): void {
	let status: string;
	try {
		status = exec("git", ["status", "--porcelain"], { cwd: config.root }).trim();
	} catch {
		p.log.error(
			`${pc.cyan(config.root)} is not a git repository.\n` +
			`  Run ${pc.green("shipx")} from inside a project, or use ${pc.green("shipx --multi")} to deploy multiple projects.`,
		);
		process.exit(1);
	}
	if (status) {
		p.log.error("Working tree is not clean. Commit or stash changes first:");
		console.log(pc.dim(status));
		process.exit(1);
	}
}

function checkBranch(config: ResolvedConfig, isBeta: boolean): string {
	const branch = exec("git", ["branch", "--show-current"], { cwd: config.root }).trim();
	if (!isBeta && !config.anyBranch && branch !== config.git.releaseBranch) {
		p.log.error(
			`On branch '${pc.yellow(branch)}', not '${pc.green(config.git.releaseBranch)}'.\n` +
			`  Switch to ${pc.green(config.git.releaseBranch)}, use ${pc.green("--beta")} for pre-releases, ` +
			`${pc.green("--any-branch")} to release from any branch, ` +
			`or set ${pc.cyan("git.releaseBranch")} in your shipx config.`,
		);
		process.exit(1);
	}
	return branch;
}

function checkRemoteSynced(config: ResolvedConfig, branch: string): void {
	try {
		exec("git", ["fetch", "origin", branch, "--quiet"], { cwd: config.root });
	} catch {
		return;
	}

	try {
		const local = exec("git", ["rev-parse", branch], { cwd: config.root }).trim();
		const remote = exec("git", ["rev-parse", `origin/${branch}`], { cwd: config.root }).trim();
		if (local !== remote) {
			const behind = exec("git", ["rev-list", "--count", `${branch}..origin/${branch}`], { cwd: config.root }).trim();
			if (parseInt(behind, 10) > 0) {
				p.log.error(
					`Local branch is ${pc.yellow(behind)} commit(s) behind ${pc.cyan(`origin/${branch}`)}.\n` +
					`  Run ${pc.green(`git pull --rebase origin ${branch}`)} first.`,
				);
				process.exit(1);
			}
		}
	} catch {
		// can't compare — not fatal
	}
}

function checkTagNotExists(config: ResolvedConfig, tagPrefix: string, currentVersion: string): void {
	const currentTag = `${tagPrefix}${currentVersion}`;
	try {
		exec("git", ["rev-parse", `refs/tags/${currentTag}`], { cwd: config.root });
		p.log.warn(`Tag ${pc.yellow(currentTag)} already exists locally — the next version must be higher`);
	} catch {
		// tag doesn't exist — good
	}
}

function checkArchived(config: ResolvedConfig): void {
	if (isRepoArchived(config.root) === true) {
		p.log.error(
			"The GitHub repository is archived — pushes will be rejected. " +
			`Unarchive it on GitHub or remove the project from shipx before retrying.`,
		);
		process.exit(1);
	}
}

/**
 * Resolve the registry that `npm publish` will actually target for this
 * package, in order of precedence:
 *   1. `publishConfig.registry` in package.json (always wins)
 *   2. Scope-specific registry (`npm config get @scope:registry`) if the
 *      package name is scoped
 *   3. Default registry (`npm config get registry`)
 *
 * Used to point `npm whoami` at the same registry the publish will use —
 * otherwise scoped packages on a private registry get a misleading
 * "not logged in" warning even when the user is actually authenticated.
 */
export function resolveNpmRegistry(
	pkg: { name?: unknown; publishConfig?: unknown },
	cwd: string,
): string | undefined {
	const publishConfig = pkg.publishConfig;
	if (publishConfig && typeof publishConfig === "object") {
		const registry = (publishConfig as { registry?: unknown }).registry;
		if (typeof registry === "string" && registry) return registry;
	}

	const name = typeof pkg.name === "string" ? pkg.name : "";
	const scopeMatch = name.match(/^(@[^/]+)\//);
	if (scopeMatch) {
		try {
			const scoped = exec("npm", ["config", "get", `${scopeMatch[1]}:registry`], { cwd }).trim();
			if (scoped && scoped !== "undefined") return scoped;
		} catch {
			// fall through to default registry
		}
	}

	try {
		const def = exec("npm", ["config", "get", "registry"], { cwd }).trim();
		if (def && def !== "undefined") return def;
	} catch {
		// fall through — let npm whoami pick its own default
	}
	return undefined;
}

function checkNpmAuth(config: ResolvedConfig): void {
	if (!config.steps.npm) return;

	const pkgPath = resolve(config.root, config.packageJsonPaths[0] ?? "package.json");
	let registry: string | undefined;
	if (existsSync(pkgPath)) {
		registry = resolveNpmRegistry(readJson(pkgPath), config.npm.cwd);
	}

	const args = ["whoami", ...(registry ? ["--registry", registry] : [])];
	try {
		const user = exec("npm", args, { cwd: config.npm.cwd }).trim();
		if (user) {
			const where = registry ? ` (${pc.dim(registry)})` : "";
			p.log.info(`npm: authenticated as ${pc.cyan(user)}${where}`);
		}
	} catch {
		const where = registry ? ` against ${pc.cyan(registry)}` : "";
		p.log.warn(
			`npm: not logged in${where}. You'll be prompted to authenticate during publish.\n` +
			`  Run ${pc.green(registry ? `npm login --registry ${registry}` : "npm login")} now to avoid interruptions.`,
		);
	}
}

function checkPackageEntryPoints(config: ResolvedConfig): void {
	if (!config.steps.npm) return;

	const pkgPath = resolve(config.root, config.packageJsonPaths[0] ?? "package.json");
	if (!existsSync(pkgPath)) return;

	const pkg = readJson(pkgPath);
	const missing: string[] = [];

	if (typeof pkg.main === "string") {
		const mainPath = resolve(config.root, pkg.main);
		if (!existsSync(mainPath)) missing.push(`main: ${pkg.main}`);
	}

	if (typeof pkg.bin === "string") {
		const binPath = resolve(config.root, pkg.bin);
		if (!existsSync(binPath)) missing.push(`bin: ${pkg.bin}`);
	} else if (pkg.bin && typeof pkg.bin === "object") {
		for (const [name, binFile] of Object.entries(pkg.bin as Record<string, string>)) {
			const binPath = resolve(config.root, binFile);
			if (!existsSync(binPath)) missing.push(`bin.${name}: ${binFile}`);
		}
	}

	if (missing.length) {
		p.log.warn(
			`Package entry points not found (may need to build first):\n` +
			missing.map((m) => `  ${pc.yellow("●")} ${m}`).join("\n"),
		);
	}
}

function checkPackageFiles(config: ResolvedConfig): void {
	if (!config.steps.npm) return;

	const pkgPath = resolve(config.root, config.packageJsonPaths[0] ?? "package.json");
	if (!existsSync(pkgPath)) return;

	const pkg = readJson(pkgPath);
	const hasFiles = Array.isArray(pkg.files);
	const hasNpmIgnore = existsSync(resolve(config.root, ".npmignore"));

	if (!hasFiles && !hasNpmIgnore) {
		p.log.warn(
			`No ${pc.cyan("files")} field in package.json and no ${pc.cyan(".npmignore")} found.\n` +
			`  Everything will be published — this may include tests, docs, and other non-essential files.\n` +
			`  Add a ${pc.green('"files"')} array to package.json to control what gets published.`,
		);
	}
}

export function runPreflight(config: ResolvedConfig, isBeta: boolean): string {
	const spinner = p.spinner();
	spinner.start("Running preflight checks");

	if (config.dryRun) {
		const branch = exec("git", ["branch", "--show-current"], { cwd: config.root }).trim();
		spinner.stop(`${pc.dim("[dry-run]")} Preflight checks (would validate tree, branch, remote, auth)`);
		return branch;
	}

	checkCleanTree(config);
	const branch = checkBranch(config, isBeta);
	checkRemoteSynced(config, branch);

	const pkgPath = resolve(config.root, config.packageJsonPaths[0] ?? "package.json");
	if (existsSync(pkgPath)) {
		const pkg = readJson(pkgPath);
		if (typeof pkg.version === "string") {
			checkTagNotExists(config, config.git.tagPrefix, pkg.version);
		}
	}

	checkArchived(config);

	spinner.stop("Preflight OK");

	checkNpmAuth(config);
	checkPackageEntryPoints(config);
	checkPackageFiles(config);

	return branch;
}
