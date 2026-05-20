import * as p from "@clack/prompts";
import type { ResolvedConfig } from "../types.ts";
import { exec } from "../utils.ts";

interface Commit {
	hash: string;
	subject: string;
	type: string;
	scope: string;
	description: string;
	breaking: boolean;
}

const TYPE_LABELS: Record<string, string> = {
	feat: "Features",
	fix: "Bug Fixes",
	perf: "Performance",
	refactor: "Refactoring",
	docs: "Documentation",
	test: "Tests",
	build: "Build",
	ci: "CI",
	chore: "Chores",
	style: "Styles",
	revert: "Reverts",
};

const DISPLAY_ORDER = ["feat", "fix", "perf", "refactor", "docs", "test", "build", "ci", "chore", "style", "revert", "other"];

function parseCommit(line: string): Commit {
	const match = line.match(/^([a-f0-9]+)\s(.+)$/);
	if (!match) return { hash: "", subject: line, type: "other", scope: "", description: line, breaking: false };

	const hash = match[1];
	const subject = match[2];
	const breaking = subject.includes("!:") || subject.toLowerCase().startsWith("breaking");
	const ccMatch = subject.match(/^(\w+)(?:\(([^)]*)\))?!?:\s*(.+)$/);

	if (ccMatch) {
		const type = ccMatch[1].toLowerCase();
		return {
			hash,
			subject,
			type: TYPE_LABELS[type] ? type : "other",
			scope: ccMatch[2] ?? "",
			description: ccMatch[3],
			breaking,
		};
	}

	return { hash, subject, type: "other", scope: "", description: subject, breaking };
}

function formatGrouped(commits: Commit[]): string {
	const groups = new Map<string, Commit[]>();
	for (const commit of commits) {
		const key = commit.type;
		if (!groups.has(key)) groups.set(key, []);
		groups.get(key)!.push(commit);
	}

	const sections: string[] = [];

	const breaking = commits.filter((c) => c.breaking);
	if (breaking.length) {
		const lines = breaking.map((c) => {
			const scope = c.scope ? `**${c.scope}:** ` : "";
			return `- ${scope}${c.description} (${c.hash})`;
		});
		sections.push(`### Breaking Changes\n\n${lines.join("\n")}`);
	}

	for (const type of DISPLAY_ORDER) {
		const group = groups.get(type);
		if (!group) continue;
		const label = TYPE_LABELS[type] ?? "Other";
		const lines = group
			.filter((c) => !c.breaking)
			.map((c) => {
				const scope = c.scope ? `**${c.scope}:** ` : "";
				return `- ${scope}${c.description} (${c.hash})`;
			});
		if (lines.length) {
			sections.push(`### ${label}\n\n${lines.join("\n")}`);
		}
	}

	return sections.join("\n\n");
}

export function generateChangelog(config: ResolvedConfig, tag: string): string {
	let lastTag = "";
	try {
		lastTag = exec("git", ["describe", "--tags", "--abbrev=0"], { cwd: config.root }).trim();
	} catch {
		// no tags yet
	}

	if (!lastTag) {
		const fallback = `- Release ${tag}`;
		p.note(fallback, "Changelog");
		return fallback;
	}

	const raw = exec(
		"git",
		["log", `${lastTag}..HEAD`, "--pretty=format:%h %s", "--no-merges"],
		{ cwd: config.root },
	).trim();

	if (!raw) {
		const fallback = `- Release ${tag}`;
		p.note(fallback, "Changelog");
		return fallback;
	}

	const commits = raw.split("\n").map(parseCommit);
	const changelog = formatGrouped(commits);

	p.note(changelog, "Changelog");
	return changelog;
}
