import * as p from "@clack/prompts";
import pc from "picocolors";
import type { ResolvedConfig } from "../types.ts";
import { errorText, exec } from "../utils.ts";

/**
 * Creates a GitHub Release for `tag`. Returns true on success, false on
 * failure (e.g. `gh` not installed, auth, network, missing tag). The
 * pipeline keeps going either way — but for beta releases the GH Release
 * is the only signal marking the build as a prerelease, so callers may
 * want to react to a `false` result there.
 */
export function createGithubRelease(
	config: ResolvedConfig,
	tag: string,
	changelog: string,
	isBeta: boolean,
): boolean {
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
		return true;
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
}
