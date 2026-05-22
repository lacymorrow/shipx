import { readdirSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import * as p from "@clack/prompts";
import pc from "picocolors";
import type { ResolvedConfig } from "../types.ts";
import { errorText, exec } from "../utils.ts";

function globToRegex(pattern: string): RegExp {
	const escaped = pattern
		.replace(/[.+^${}()|[\]\\]/g, "\\$&")
		.replace(/\*/g, "[^/]*");
	return new RegExp(`^${escaped}$`);
}

export function resolveGlobs(root: string, patterns: string[]): string[] {
	const results: string[] = [];
	for (const pattern of patterns) {
		const dir = resolve(root, dirname(pattern));
		const filePattern = basename(pattern);
		const regex = globToRegex(filePattern);
		try {
			for (const entry of readdirSync(dir)) {
				if (regex.test(entry)) {
					results.push(resolve(dir, entry));
				}
			}
		} catch {
			// directory doesn't exist — skip
		}
	}
	return [...new Set(results)].sort();
}

function uploadAssets(
	config: ResolvedConfig,
	tag: string,
	files: string[],
): { uploaded: string[]; failed: string[] } {
	const uploaded: string[] = [];
	const failed: string[] = [];

	for (const file of files) {
		const name = basename(file);
		try {
			exec("gh", ["release", "upload", tag, file, "--clobber"], {
				cwd: config.root,
			});
			uploaded.push(name);
		} catch (err) {
			failed.push(name);
			p.log.warn(`Failed to upload ${pc.cyan(name)}: ${errorText(err)}`);
		}
	}

	return { uploaded, failed };
}

export function createGithubRelease(
	config: ResolvedConfig,
	tag: string,
	changelog: string,
	isBeta: boolean,
): boolean {
	const isDraft = config.github.draft;
	const assetPatterns = config.github.assets;
	const hasAssets = assetPatterns.length > 0;

	const spinner = p.spinner();
	spinner.start(isDraft ? "Creating draft GitHub release" : "Creating GitHub release");

	const releaseNotes = `## Changes\n\n${changelog}`;

	let url = "";
	try {
		const result = exec(
			"gh",
			[
				"release", "create", tag,
				"--title", tag,
				"--notes", releaseNotes,
				...(isBeta ? ["--prerelease"] : []),
				...(isDraft ? ["--draft"] : []),
			],
			{ cwd: config.root },
		);

		url = result.trim();

		if (isDraft) {
			spinner.stop(`Draft release created — ${pc.cyan(url)}`);
		} else {
			spinner.stop("GitHub release created");
		}
	} catch (err) {
		spinner.stop(pc.red("GitHub release failed"));
		p.log.error(errorText(err));
		if (isBeta) {
			p.log.warn(
				"Beta release without a GitHub Release means downstream consumers cannot tell this is a prerelease. " +
				`Create it manually: ${pc.green(`gh release create ${tag} --prerelease`)}`,
			);
		}
		return false;
	}

	if (hasAssets) {
		const files = resolveGlobs(config.root, assetPatterns);
		if (files.length === 0) {
			p.log.warn(`No files matched asset patterns: ${assetPatterns.map((a) => pc.cyan(a)).join(", ")}`);
		} else {
			const assetSpinner = p.spinner();
			assetSpinner.start(`Uploading ${files.length} release asset(s)`);

			const { uploaded, failed } = uploadAssets(config, tag, files);

			if (failed.length > 0) {
				assetSpinner.stop(pc.yellow(`Uploaded ${uploaded.length}/${files.length} assets (${failed.length} failed)`));
			} else {
				assetSpinner.stop(`Uploaded ${uploaded.length} release asset(s)`);
			}
		}
	}

	if (isDraft && url) {
		p.log.info(`Review and publish at ${pc.cyan(url)}`);
		try {
			exec("open", [url]);
		} catch {
			// non-macOS or no browser — URL is already printed
		}
	}

	return true;
}
