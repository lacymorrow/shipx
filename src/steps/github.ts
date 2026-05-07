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
	const spinner = p.spinner();
	spinner.start("Creating GitHub release");

	const releaseNotes = `## Changes\n\n${changelog}`;

	try {
		exec(
			"gh",
			[
				"release", "create", tag,
				"--title", tag,
				"--notes", releaseNotes,
				...(isBeta ? ["--prerelease"] : []),
			],
			{ cwd: config.root },
		);
		spinner.stop("GitHub release created");
	} catch (err) {
		spinner.stop(pc.red("GitHub release failed"));
		p.log.error(errorText(err));
	}
}
