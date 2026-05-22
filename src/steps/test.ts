import * as p from "@clack/prompts";
import pc from "picocolors";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { ResolvedConfig } from "../types.ts";
import { errorText, exec, readJson } from "../utils.ts";

function detectPackageManager(root: string): string {
	if (existsSync(resolve(root, "bun.lockb")) || existsSync(resolve(root, "bun.lock"))) return "bun";
	if (existsSync(resolve(root, "pnpm-lock.yaml"))) return "pnpm";
	if (existsSync(resolve(root, "yarn.lock"))) return "yarn";
	return "npm";
}

function hasTestScript(root: string, scriptName: string): boolean {
	const pkgPath = resolve(root, "package.json");
	if (!existsSync(pkgPath)) return false;
	const pkg = readJson(pkgPath);
	const scripts = pkg.scripts as Record<string, string> | undefined;
	return !!scripts?.[scriptName];
}

export function runTests(config: ResolvedConfig): void {
	const scriptName = config.testScript;

	if (!hasTestScript(config.root, scriptName)) {
		p.log.warn(`No "${scriptName}" script found in package.json — skipping tests`);
		return;
	}

	if (config.dryRun) {
		p.log.info(`${pc.dim("[dry-run]")} Would run test script: ${pc.cyan(scriptName)}`);
		return;
	}

	const pm = detectPackageManager(config.root);
	const args = pm === "npm" ? ["run", scriptName] : ["run", scriptName];
	const display = `${pm} run ${scriptName}`;

	const spinner = p.spinner();
	spinner.start(`Running ${pc.cyan(display)}`);

	try {
		exec(pm, args, { cwd: config.root, stdio: "pipe" });
		spinner.stop(`Tests passed`);
	} catch (err) {
		spinner.stop(pc.red("Tests failed"));
		p.log.error(errorText(err));
		p.log.info(`Fix the failing tests, or use ${pc.green("--no-tests")} to skip.`);
		process.exit(1);
	}
}
