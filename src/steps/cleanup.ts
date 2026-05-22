import * as p from "@clack/prompts";
import pc from "picocolors";
import { existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import type { ResolvedConfig } from "../types.ts";
import { errorText, exec } from "../utils.ts";

function detectInstall(root: string): { cmd: string; args: string[] } {
	if (existsSync(resolve(root, "bun.lockb")) || existsSync(resolve(root, "bun.lock"))) {
		return { cmd: "bun", args: ["install", "--frozen-lockfile"] };
	}
	if (existsSync(resolve(root, "pnpm-lock.yaml"))) {
		return { cmd: "pnpm", args: ["install", "--frozen-lockfile"] };
	}
	if (existsSync(resolve(root, "yarn.lock"))) {
		return { cmd: "yarn", args: ["install", "--frozen-lockfile"] };
	}
	return { cmd: "npm", args: ["ci"] };
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

	const install = detectInstall(config.root);
	const display = `${install.cmd} ${install.args.join(" ")}`;
	spinner.message(`Installing dependencies (${pc.cyan(display)})`);

	try {
		exec(install.cmd, install.args, { cwd: config.root, stdio: "pipe" });
		spinner.stop("Clean install complete");
	} catch (err) {
		spinner.stop(pc.red("Install failed"));
		p.log.error(errorText(err));
		process.exit(1);
	}
}
