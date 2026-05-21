import * as p from "@clack/prompts";
import pc from "picocolors";
import { existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import type { ResolvedConfig } from "../types.ts";
import { errorText, shell } from "../utils.ts";

function detectInstallCommand(root: string): string {
	if (existsSync(resolve(root, "bun.lockb")) || existsSync(resolve(root, "bun.lock"))) return "bun install --frozen-lockfile";
	if (existsSync(resolve(root, "pnpm-lock.yaml"))) return "pnpm install --frozen-lockfile";
	if (existsSync(resolve(root, "yarn.lock"))) return "yarn install --frozen-lockfile";
	return "npm ci";
}

export function runCleanup(config: ResolvedConfig): void {
	const nodeModules = resolve(config.root, "node_modules");

	if (config.dryRun) {
		p.log.info(`${pc.dim("[dry-run]")} Would delete node_modules and reinstall`);
		return;
	}

	const spinner = p.spinner();
	spinner.start("Cleaning node_modules");

	if (existsSync(nodeModules)) {
		try {
			rmSync(nodeModules, { recursive: true, force: true });
		} catch (err) {
			spinner.stop(pc.red("Failed to remove node_modules"));
			p.log.error(errorText(err));
			process.exit(1);
		}
	}

	const installCmd = detectInstallCommand(config.root);
	spinner.message(`Installing dependencies (${pc.cyan(installCmd)})`);

	try {
		shell(installCmd, { cwd: config.root, stdio: "pipe" });
		spinner.stop("Clean install complete");
	} catch (err) {
		spinner.stop(pc.red("Install failed"));
		p.log.error(errorText(err));
		process.exit(1);
	}
}
