import fs from "node:fs";
import path from "node:path";
import * as p from "@clack/prompts";
import pc from "picocolors";
import type { ResolvedConfig } from "../types.ts";
import { exec } from "../utils.ts";
import type { Commit } from "./changelog.ts";

/**
 * Conventional commit type to Keep a Changelog category.
 * Types missing from this map stay out of the file: a changelog is for the people
 * using the project, and a CI tweak is not news to them.
 */
const CATEGORY_BY_TYPE: Record<string, string> = {
	feat: "Added",
	fix: "Fixed",
	perf: "Changed",
	refactor: "Changed",
	revert: "Changed",
};

/** Keep a Changelog's canonical category order. */
const CATEGORY_ORDER = ["Added", "Changed", "Deprecated", "Removed", "Fixed", "Security"];

const UNRELEASED_HEADING = /^##\s+\[?unreleased\]?\s*$/i;
const ANY_H2 = /^##\s+\S/;
const LINK_DEFINITION = /^\[([^\]]+)\]:\s*(\S+)/;

/**
 * Renders commits as Keep a Changelog sections.
 * Breaking changes lead their category, which is the one ordering rule that matters
 * to somebody deciding whether an upgrade is safe.
 */
export function formatKeepAChangelog(commits: Commit[]): string {
	const leading = new Map<string, string[]>();
	const rest = new Map<string, string[]>();

	for (const commit of commits) {
		const category = commit.breaking ? "Changed" : CATEGORY_BY_TYPE[commit.type];
		if (!category) continue;

		const scope = commit.scope ? `**${commit.scope}:** ` : "";
		const prefix = commit.breaking ? "**Breaking:** " : "";
		const line = `- ${prefix}${scope}${commit.description} (${commit.hash})`;

		const bucket = commit.breaking ? leading : rest;
		if (!bucket.has(category)) bucket.set(category, []);
		bucket.get(category)?.push(line);
	}

	const sections: string[] = [];
	for (const category of CATEGORY_ORDER) {
		const lines = [...(leading.get(category) ?? []), ...(rest.get(category) ?? [])];
		if (!lines.length) continue;
		sections.push(`### ${category}\n\n${lines.join("\n")}`);
	}

	return sections.join("\n\n");
}

/** Normalizes any git remote URL into a browsable https GitHub URL. */
export function normalizeRepoUrl(remote: string): string {
	return remote
		.trim()
		.replace(/^git@([^:]+):/, "https://$1/")
		.replace(/^ssh:\/\/git@/, "https://")
		.replace(/\.git$/, "");
}

interface UnreleasedBlock {
	/** Index of the Unreleased heading, or -1 when the file has none. */
	headingIndex: number;
	/** Index just past the Unreleased body. */
	endIndex: number;
	/** The body under the heading, trimmed, with link definitions removed. */
	body: string;
}

function findUnreleased(lines: string[]): UnreleasedBlock {
	const headingIndex = lines.findIndex((line) => UNRELEASED_HEADING.test(line));
	if (headingIndex === -1) return { headingIndex: -1, endIndex: -1, body: "" };

	let endIndex = lines.length;
	for (let i = headingIndex + 1; i < lines.length; i++) {
		const line = lines[i];
		if (line !== undefined && ANY_H2.test(line)) {
			endIndex = i;
			break;
		}
	}

	const body = lines
		.slice(headingIndex + 1, endIndex)
		.filter((line) => !LINK_DEFINITION.test(line))
		.join("\n")
		.trim();

	return { headingIndex, endIndex, body };
}

/** Finds where a new release section should go when the file has no Unreleased heading. */
function firstReleaseIndex(lines: string[]): number {
	const index = lines.findIndex((line) => ANY_H2.test(line));
	return index === -1 ? lines.length : index;
}

function updateLinkDefinitions(
	lines: string[],
	opts: { version: string; tag: string; previousTag: string; repoUrl: string },
): string[] {
	// Only projects already using link definitions get new ones. Adding them to a file
	// that never had them would be a style change nobody asked for.
	const hasDefinitions = lines.some((line) => LINK_DEFINITION.test(line));
	if (!hasDefinitions || !opts.repoUrl) return lines;

	const compare = (from: string, to: string) => `${opts.repoUrl}/compare/${from}...${to}`;
	const versionLine = opts.previousTag
		? `[${opts.version}]: ${compare(opts.previousTag, opts.tag)}`
		: `[${opts.version}]: ${opts.repoUrl}/releases/tag/${opts.tag}`;

	const out: string[] = [];
	let inserted = false;

	for (const line of lines) {
		const match = LINK_DEFINITION.exec(line);
		if (match) {
			const label = match[1] ?? "";
			// Point Unreleased at everything since the tag we are cutting now.
			if (label.toLowerCase() === "unreleased") {
				out.push(`[Unreleased]: ${compare(opts.tag, "HEAD")}`);
				if (!inserted) {
					out.push(versionLine);
					inserted = true;
				}
				continue;
			}
			// Replace a stale definition for this same version rather than duplicating it.
			if (label === opts.version) {
				if (!inserted) {
					out.push(versionLine);
					inserted = true;
				}
				continue;
			}
		}
		out.push(line);
	}

	if (!inserted) {
		const lastDefinition = out.reduce((acc, line, i) => (LINK_DEFINITION.test(line) ? i : acc), -1);
		out.splice(lastDefinition + 1, 0, versionLine);
	}

	return out;
}

export interface UpdateChangelogOptions {
	version: string;
	date: string;
	tag: string;
	previousTag?: string;
	repoUrl?: string;
	/** Commit-derived sections, used only when the Unreleased section is empty. */
	generated?: string;
}

/**
 * Inserts a release section into a Keep a Changelog file.
 *
 * When the Unreleased section has content, that content becomes the release and
 * Unreleased is emptied. Hand-written notes beat generated ones every time, and this
 * is the step whose absence lets an Unreleased section quietly accumulate several
 * shipped releases.
 *
 * Returns null when there is nothing to record, or when this version is already in
 * the file, so a re-run after a failed release does not duplicate the section.
 */
export function updateChangelogContent(
	existing: string,
	opts: UpdateChangelogOptions,
): string | null {
	const alreadyPresent = new RegExp(
		`^##\\s+\\[?${opts.version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\]?(\\s|$)`,
		"m",
	).test(existing);
	if (alreadyPresent) return null;

	const lines = existing.split(/\r?\n/);
	const unreleased = findUnreleased(lines);
	const body = unreleased.body || (opts.generated ?? "").trim();
	if (!body) return null;

	const section = [`## [${opts.version}] - ${opts.date}`, "", body, ""];

	let out: string[];
	if (unreleased.headingIndex === -1) {
		const at = firstReleaseIndex(lines);
		out = [...lines.slice(0, at), ...section, ...lines.slice(at)];
	} else {
		// Keep the Unreleased heading, drop its body, then put the release below it.
		out = [
			...lines.slice(0, unreleased.headingIndex + 1),
			"",
			...section,
			...lines.slice(unreleased.endIndex),
		];
	}

	out = updateLinkDefinitions(out, {
		version: opts.version,
		tag: opts.tag,
		previousTag: opts.previousTag ?? "",
		repoUrl: opts.repoUrl ?? "",
	});

	// Collapse the runs of blank lines the splices can leave behind.
	const collapsed = out.filter(
		(line, i) => !(line.trim() === "" && out[i - 1]?.trim() === ""),
	);

	return `${collapsed.join("\n").trimEnd()}\n`;
}

function resolveRepoUrl(config: ResolvedConfig): string {
	try {
		return normalizeRepoUrl(exec("git", ["remote", "get-url", "origin"], { cwd: config.root }));
	} catch {
		return "";
	}
}

function resolvePreviousTag(config: ResolvedConfig): string {
	try {
		return exec("git", ["describe", "--tags", "--abbrev=0"], { cwd: config.root }).trim();
	} catch {
		return "";
	}
}

/**
 * Writes the release into the project's CHANGELOG.md when it has one.
 *
 * Returns the path written, relative to the project root, so the caller can stage it
 * into the release commit. Returns null when the project has no changelog, when the
 * file is disabled in config, or when there was nothing to record.
 */
export function updateChangelogFile(
	config: ResolvedConfig,
	version: string,
	tag: string,
	commits: Commit[],
): string | null {
	const relativePath = config.changelogFile;
	if (!relativePath) return null;

	const absolutePath = path.resolve(config.root, relativePath);
	// Only ever update an existing changelog. Creating one is a decision for a human.
	if (!fs.existsSync(absolutePath)) return null;

	let existing: string;
	try {
		existing = fs.readFileSync(absolutePath, "utf-8");
	} catch (err) {
		p.log.warn(`Could not read ${pc.cyan(relativePath)}: ${(err as Error).message}`);
		return null;
	}

	const updated = updateChangelogContent(existing, {
		version,
		date: new Date().toISOString().slice(0, 10),
		tag,
		previousTag: resolvePreviousTag(config),
		repoUrl: resolveRepoUrl(config),
		generated: formatKeepAChangelog(commits),
	});

	if (updated === null) {
		p.log.info(`${pc.cyan(relativePath)} already covers ${pc.green(version)}, leaving it alone`);
		return null;
	}

	try {
		fs.writeFileSync(absolutePath, updated);
	} catch (err) {
		p.log.warn(`Could not write ${pc.cyan(relativePath)}: ${(err as Error).message}`);
		return null;
	}

	p.log.success(`Added ${pc.green(version)} to ${pc.cyan(relativePath)}`);
	return relativePath;
}
