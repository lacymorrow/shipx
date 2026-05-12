import * as p from "@clack/prompts";
import pc from "picocolors";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { ResolvedConfig } from "../types.ts";
import { errorText, exec } from "../utils.ts";

/**
 * Bump Cargo workspace version(s) using `cargo set-version --workspace`.
 * Returns the list of workspace directories that were bumped (for git staging).
 * Requires the `cargo-edit` crate: `cargo install cargo-edit`.
 */
export function bumpCargoWorkspaces(
	config: ResolvedConfig,
	newVersion: string,
): string[] {
	if (!config.cargoWorkspaces.length) return [];

	const spinner = p.spinner();
	spinner.start("Bumping Cargo.toml versions");

	const bumped: string[] = [];

	for (const relDir of config.cargoWorkspaces) {
		const absDir = resolve(config.root, relDir);
		if (!existsSync(absDir)) {
			p.log.warn(`Cargo workspace not found: ${pc.dim(absDir)}`);
			continue;
		}

		try {
			exec("cargo", ["set-version", "--workspace", newVersion], { cwd: absDir });
			bumped.push(relDir);
		} catch (err) {
			spinner.stop(pc.red(`Failed to bump Cargo versions in ${pc.cyan(relDir)}`));
			p.log.error(errorText(err));
			p.log.info(
				`Install cargo-edit with: ${pc.cyan("cargo install cargo-edit")}`,
			);
			process.exit(1);
		}
	}

	const dirList = bumped.map((d) => pc.cyan(d)).join(", ");
	spinner.stop(`Bumped Cargo workspace(s) ${dirList} → ${pc.green(newVersion)}`);

	return bumped;
}

/** Resolve extra tag names from their template strings. */
export function resolveExtraTags(
	config: ResolvedConfig,
	tag: string,
	newVersion: string,
): string[] {
	return config.git.extraTags.map((tpl) =>
		tpl.replace(/\{tag\}/g, tag).replace(/\{version\}/g, newVersion),
	);
}
