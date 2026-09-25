import * as p from "@clack/prompts";
import pc from "picocolors";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { ResolvedConfig } from "../types.ts";
import { errorText, run } from "../utils.ts";

/**
 * List the repo-relative Cargo.toml / Cargo.lock paths currently modified in
 * the working tree. `cargo set-version --workspace` resolves upward to the
 * real workspace root, so the rewritten files can live anywhere in the repo —
 * asking git what changed is the only honest staging list.
 */
async function changedCargoFiles(root: string): Promise<string[]> {
	// --no-renames keeps every record a plain "XY path" — no extra
	// original-path field to skip.
	const out = await run("git", ["status", "--porcelain", "-z", "--no-renames"], { cwd: root });
	return out
		.split("\0")
		.filter(Boolean)
		.map((entry) => entry.slice(3))
		.filter((path) => /(^|\/)Cargo\.(toml|lock)$/.test(path));
}

/**
 * Bump Cargo workspace version(s) using `cargo set-version --workspace`.
 * Returns the repo-relative Cargo.toml/Cargo.lock paths the bump rewrote
 * (for git staging) — not just the directories the command ran in, since
 * cargo bumps every workspace member wherever it lives.
 * Requires the `cargo-edit` crate: `cargo install cargo-edit`.
 */
export async function bumpCargoWorkspaces(
	config: ResolvedConfig,
	newVersion: string,
): Promise<string[]> {
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
			await run("cargo", ["set-version", "--workspace", newVersion], { cwd: absDir });
			bumped.push(relDir);
		} catch (err) {
			spinner.stop(pc.red(`Failed to bump Cargo versions in ${pc.cyan(relDir)}`));
			p.log.info(
				`Install cargo-edit with: ${pc.cyan("cargo install cargo-edit")}`,
			);
			// Re-throw so cli.ts can decide whether to roll back the release
			// commit/tag (which haven't been created yet at this point, but the
			// surrounding pipeline still needs the chance to clean up).
			throw new Error(
				`cargo set-version failed in ${relDir}: ${errorText(err)}`,
			);
		}
	}

	const dirList = bumped.map((d) => pc.cyan(d)).join(", ");
	spinner.stop(`Bumped Cargo workspace(s) ${dirList} → ${pc.green(newVersion)}`);

	if (!bumped.length) return [];
	return changedCargoFiles(config.root);
}
