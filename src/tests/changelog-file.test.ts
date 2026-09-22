import { describe, expect, test } from "bun:test";
import { parseCommit } from "../steps/changelog.ts";
import {
	formatKeepAChangelog,
	normalizeRepoUrl,
	updateChangelogContent,
} from "../steps/changelog-file.ts";

const REPO = "https://github.com/lacymorrow/example";

const WITH_UNRELEASED = `# Changelog

All notable changes to this project are documented in this file.

## [Unreleased]

### Added

- You can now export a session as Markdown.

### Fixed

- Quitting no longer leaves the rc file unparseable.

## [1.1.0] - 2026-08-01

### Changed

- The license is FSL-1.1-MIT.

[Unreleased]: ${REPO}/compare/v1.1.0...HEAD
[1.1.0]: ${REPO}/releases/tag/v1.1.0
`;

const EMPTY_UNRELEASED = `# Changelog

## [Unreleased]

## [1.1.0] - 2026-08-01

### Changed

- The license is FSL-1.1-MIT.

[Unreleased]: ${REPO}/compare/v1.1.0...HEAD
[1.1.0]: ${REPO}/releases/tag/v1.1.0
`;

const opts = {
	version: "1.2.0",
	date: "2026-09-22",
	tag: "v1.2.0",
	previousTag: "v1.1.0",
	repoUrl: REPO,
};

describe("updateChangelogContent", () => {
	test("promotes the Unreleased section into the new release", () => {
		const out = updateChangelogContent(WITH_UNRELEASED, opts);
		expect(out).toContain("## [1.2.0] - 2026-09-22");
		expect(out).toContain("- You can now export a session as Markdown.");
		expect(out).toContain("- Quitting no longer leaves the rc file unparseable.");
	});

	test("leaves the Unreleased heading in place but empty", () => {
		const out = updateChangelogContent(WITH_UNRELEASED, opts) ?? "";
		const unreleasedBody = out.slice(
			out.indexOf("## [Unreleased]") + "## [Unreleased]".length,
			out.indexOf("## [1.2.0]"),
		);
		expect(unreleasedBody.trim()).toBe("");
	});

	test("keeps the new release above the previous one", () => {
		const out = updateChangelogContent(WITH_UNRELEASED, opts) ?? "";
		expect(out.indexOf("## [1.2.0]")).toBeLessThan(out.indexOf("## [1.1.0]"));
	});

	test("prefers hand-written Unreleased notes over generated ones", () => {
		const out =
			updateChangelogContent(WITH_UNRELEASED, {
				...opts,
				generated: "### Added\n\n- Generated entry that should not appear (abc1234)",
			}) ?? "";
		expect(out).not.toContain("Generated entry that should not appear");
		expect(out).toContain("- You can now export a session as Markdown.");
	});

	test("falls back to the generated entries when Unreleased is empty", () => {
		const out =
			updateChangelogContent(EMPTY_UNRELEASED, {
				...opts,
				generated: "### Added\n\n- Sessions export as Markdown (abc1234)",
			}) ?? "";
		expect(out).toContain("## [1.2.0] - 2026-09-22");
		expect(out).toContain("- Sessions export as Markdown (abc1234)");
	});

	test("records nothing when there is nothing to record", () => {
		expect(updateChangelogContent(EMPTY_UNRELEASED, opts)).toBeNull();
	});

	test("does not duplicate a version already in the file", () => {
		const out = updateChangelogContent(WITH_UNRELEASED, { ...opts, version: "1.1.0" });
		expect(out).toBeNull();
	});

	test("points Unreleased at the tag it just cut and adds the version link", () => {
		const out = updateChangelogContent(WITH_UNRELEASED, opts) ?? "";
		expect(out).toContain(`[Unreleased]: ${REPO}/compare/v1.2.0...HEAD`);
		expect(out).toContain(`[1.2.0]: ${REPO}/compare/v1.1.0...v1.2.0`);
	});

	test("links the first release to its tag when there is no previous tag", () => {
		const out =
			updateChangelogContent(WITH_UNRELEASED, { ...opts, previousTag: "" }) ?? "";
		expect(out).toContain(`[1.2.0]: ${REPO}/releases/tag/v1.2.0`);
	});

	test("leaves link definitions alone in a file that never used them", () => {
		const plain = "# Changelog\n\n## [Unreleased]\n\n### Added\n\n- A thing.\n";
		const out = updateChangelogContent(plain, opts) ?? "";
		expect(out).not.toContain("]: https://");
		expect(out).toContain("## [1.2.0] - 2026-09-22");
	});

	test("inserts above the first release when the file has no Unreleased heading", () => {
		const noUnreleased = "# Changelog\n\n## [1.1.0] - 2026-08-01\n\n### Changed\n\n- A thing.\n";
		const out =
			updateChangelogContent(noUnreleased, {
				...opts,
				generated: "### Added\n\n- A new thing (abc1234)",
			}) ?? "";
		expect(out.indexOf("## [1.2.0]")).toBeLessThan(out.indexOf("## [1.1.0]"));
		expect(out.indexOf("# Changelog")).toBeLessThan(out.indexOf("## [1.2.0]"));
	});

	test("never leaves a run of blank lines behind", () => {
		const out = updateChangelogContent(WITH_UNRELEASED, opts) ?? "";
		expect(out).not.toMatch(/\n\n\n/);
	});

	test("ends with exactly one trailing newline", () => {
		const out = updateChangelogContent(WITH_UNRELEASED, opts) ?? "";
		expect(out.endsWith("\n")).toBe(true);
		expect(out.endsWith("\n\n")).toBe(false);
	});
});

describe("formatKeepAChangelog", () => {
	test("maps conventional types onto Keep a Changelog categories", () => {
		const out = formatKeepAChangelog([
			parseCommit("aaa0001 feat: sessions export as Markdown"),
			parseCommit("bbb0002 fix: quitting leaves the rc file valid"),
			parseCommit("ccc0003 perf: startup is faster"),
		]);
		expect(out).toContain("### Added\n\n- sessions export as Markdown (aaa0001)");
		expect(out).toContain("### Changed\n\n- startup is faster (ccc0003)");
		expect(out).toContain("### Fixed\n\n- quitting leaves the rc file valid (bbb0002)");
	});

	test("keeps categories in Keep a Changelog order", () => {
		const out = formatKeepAChangelog([
			parseCommit("bbb0002 fix: a fix"),
			parseCommit("aaa0001 feat: a feature"),
		]);
		expect(out.indexOf("### Added")).toBeLessThan(out.indexOf("### Fixed"));
	});

	test("leads its category with breaking changes", () => {
		const out = formatKeepAChangelog([
			parseCommit("aaa0001 refactor: an ordinary change"),
			parseCommit("bbb0002 feat!: drop the old API"),
		]);
		const changed = out.slice(out.indexOf("### Changed"));
		expect(changed.indexOf("**Breaking:**")).toBeLessThan(changed.indexOf("an ordinary change"));
	});

	test("keeps housekeeping commits out of the file", () => {
		const out = formatKeepAChangelog([
			parseCommit("aaa0001 chore: bump deps"),
			parseCommit("bbb0002 ci: tweak the workflow"),
			parseCommit("ccc0003 docs: fix a typo"),
			parseCommit("ddd0004 test: add a case"),
		]);
		expect(out).toBe("");
	});

	test("carries the scope through", () => {
		const out = formatKeepAChangelog([parseCommit("aaa0001 fix(auth): expired tokens refresh")]);
		expect(out).toContain("- **auth:** expired tokens refresh (aaa0001)");
	});
});

describe("normalizeRepoUrl", () => {
	test("converts an ssh remote into a browsable url", () => {
		expect(normalizeRepoUrl("git@github.com:lacymorrow/example.git")).toBe(REPO);
	});

	test("strips the .git suffix from an https remote", () => {
		expect(normalizeRepoUrl(`${REPO}.git\n`)).toBe(REPO);
	});

	test("leaves a clean https remote alone", () => {
		expect(normalizeRepoUrl(REPO)).toBe(REPO);
	});
});
