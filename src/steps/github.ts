import * as p from "@clack/prompts";
import pc from "picocolors";
import type { ResolvedConfig } from "../types.ts";
import { errorText, exec } from "../utils.ts";

export function createGithubRelease(
	config: ResolvedConfig,
	tag: string,
	changelog: string,
	isBeta: boolean,
): void {
	const isDraft = config.github.draft;
	const spinner = p.spinner();
	spinner.start(isDraft ? "Creating draft GitHub release" : "Creating GitHub release");

	const releaseNotes = `## Changes\n\n${changelog}`;

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

		if (isDraft) {
			const url = result.trim();
			spinner.stop(`Draft release created — edit and publish at ${pc.cyan(url)}`);
			try {
				exec("open", [url]);
			} catch {
				// non-macOS or no browser — URL is already printed
			}
		} else {
			spinner.stop("GitHub release created");
		}
	} catch (err) {
		spinner.stop(pc.red("GitHub release failed"));
		p.log.error(errorText(err));
	}
}
