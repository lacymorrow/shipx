import * as p from "@clack/prompts";
import type { ResolvedConfig } from "../types.ts";
import { exec } from "../utils.ts";

export function generateChangelog(config: ResolvedConfig, tag: string): string {
	let lastTag = "";
	try {
		lastTag = exec("git", ["describe", "--tags", "--abbrev=0"], { cwd: config.root }).trim();
	} catch {
		// no tags yet
	}

	let changelog = "";
	if (lastTag) {
		changelog = exec(
			"git",
			["log", `${lastTag}..HEAD`, "--pretty=format:- %s (%h)", "--no-merges"],
			{ cwd: config.root },
		).trim();
	}

	if (!changelog) changelog = `- Release ${tag}`;
	p.note(changelog, "Changelog");
	return changelog;
}
