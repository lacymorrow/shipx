import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { ResolvedXcodeConfig, XcodePlatform } from "../types.ts";
import { exec } from "../utils.ts";

export const XCODE_PLATFORM_DESTINATIONS: Record<XcodePlatform, string> = {
	ios: "generic/platform=iOS",
	macos: "generic/platform=macOS",
	tvos: "generic/platform=tvOS",
	visionos: "generic/platform=visionOS",
};

/** `project.yml` (XcodeGen) or a `*.xcodeproj` directory at the project root. */
export function hasXcodeProject(root: string): boolean {
	if (existsSync(join(root, "project.yml"))) return true;
	try {
		return readdirSync(root).some((e) => e.endsWith(".xcodeproj"));
	} catch {
		return false;
	}
}

/** An Xcode project is a repo with project.yml or *.xcodeproj and no package.json. */
export function isXcodeProject(root: string): boolean {
	return !existsSync(join(root, "package.json")) && hasXcodeProject(root);
}

/** Xcode project with no package.json: the npm and Homebrew steps have nothing to ship. */
export function isXcodeOnly(config: { xcode: { enabled: boolean }; packageJsonPaths: string[] }): boolean {
	return config.xcode.enabled && config.packageJsonPaths.length === 0;
}

/** Default `versionFile`: `project.yml` when present, otherwise empty. */
export function detectVersionFile(root: string): string {
	return existsSync(join(root, "project.yml")) ? "project.yml" : "";
}

/** Scheme guess: XcodeGen `name:`, else the `.xcodeproj` basename. */
export function detectScheme(root: string): string {
	const yml = join(root, "project.yml");
	if (existsSync(yml)) {
		const m = readFileSync(yml, "utf-8").match(/^name:\s*["']?([^"'\n#]+?)["']?\s*(?:#.*)?$/m);
		if (m) return m[1];
	}
	try {
		const proj = readdirSync(root).find((e) => e.endsWith(".xcodeproj"));
		if (proj) return basename(proj, ".xcodeproj");
	} catch {
		// unreadable root
	}
	return "";
}

type SettingSyntax = "yaml" | "xcconfig";

function syntaxFor(file: string): SettingSyntax {
	return file.endsWith(".xcconfig") ? "xcconfig" : "yaml";
}

function settingRegex(key: string, syntax: SettingSyntax): RegExp {
	if (syntax === "xcconfig") {
		return new RegExp(`^(\\s*${key}\\s*=\\s*)([^\\s/]+)`, "gm");
	}
	return new RegExp(`^(\\s*${key}:\\s*)(["']?)([^"'\\s#]+)\\2`, "gm");
}

/** Value of `key` in project.yml or a .xcconfig text. First occurrence wins. */
export function readSetting(content: string, file: string, key: string): string | null {
	const syntax = syntaxFor(file);
	const m = settingRegex(key, syntax).exec(content);
	if (!m) return null;
	return syntax === "xcconfig" ? m[2] : m[3];
}

/** Rewrite every occurrence of `key`. Returns null when the key is absent. */
export function writeSetting(content: string, file: string, key: string, value: string): string | null {
	const syntax = syntaxFor(file);
	const re = settingRegex(key, syntax);
	if (!re.test(content)) return null;
	re.lastIndex = 0;
	if (syntax === "xcconfig") return content.replace(re, (_m, pre: string) => `${pre}${value}`);
	return content.replace(re, (_m, pre: string, quote: string) => `${pre}${quote || '"'}${value}${quote || '"'}`);
}

export function readMarketingVersion(root: string, versionFile: string): string | null {
	const abs = resolve(root, versionFile);
	if (!versionFile || !existsSync(abs)) return null;
	return readSetting(readFileSync(abs, "utf-8"), versionFile, "MARKETING_VERSION");
}

export function writeMarketingVersion(root: string, versionFile: string, version: string): boolean {
	return writeVersionFileSetting(root, versionFile, "MARKETING_VERSION", version);
}

function writeVersionFileSetting(root: string, versionFile: string, key: string, value: string): boolean {
	const abs = resolve(root, versionFile);
	if (!versionFile || !existsSync(abs)) return false;
	const content = readFileSync(abs, "utf-8");
	const updated = writeSetting(content, versionFile, key, value);
	if (updated === null) return false;
	if (updated !== content) writeFileSync(abs, updated);
	return true;
}

/** Current CURRENT_PROJECT_VERSION in the version file (used by buildNumber "increment"). */
export function readStoredBuildNumber(root: string, versionFile: string): number | null {
	const abs = resolve(root, versionFile);
	if (!versionFile || !existsSync(abs)) return null;
	const v = readSetting(readFileSync(abs, "utf-8"), versionFile, "CURRENT_PROJECT_VERSION");
	return v !== null && /^\d+$/.test(v) ? Number(v) : null;
}

/** Persist the incremented build number. Only meaningful for buildNumber "increment". */
export function writeStoredBuildNumber(root: string, versionFile: string, build: number): boolean {
	return writeVersionFileSetting(root, versionFile, "CURRENT_PROJECT_VERSION", String(build));
}

/**
 * Build number for this release.
 * - commitCount: `git rev-list --count HEAD` plus `buildNumberOffset`. `pendingCommits`
 *   adds the release commit a dry run has not made yet.
 * - increment: stored CURRENT_PROJECT_VERSION plus one in a real run's bump step, so
 *   at archive time the stored value is already the build number (`alreadyBumped`).
 */
export function computeBuildNumber(
	root: string,
	xcode: Pick<ResolvedXcodeConfig, "buildNumber" | "buildNumberOffset" | "versionFile">,
	opts: { pendingCommits?: number; alreadyBumped?: boolean } = {},
): number {
	if (xcode.buildNumber === "increment") {
		const stored = readStoredBuildNumber(root, xcode.versionFile);
		if (stored === null) {
			throw new Error(`buildNumber "increment" needs CURRENT_PROJECT_VERSION in ${xcode.versionFile || "the version file"}`);
		}
		return opts.alreadyBumped ? stored : stored + 1;
	}
	const count = Number.parseInt(exec("git", ["rev-list", "--count", "HEAD"], { cwd: root }).trim(), 10);
	if (!Number.isFinite(count)) throw new Error("could not count commits for the build number");
	return count + xcode.buildNumberOffset + (opts.pendingCommits ?? 0);
}

function parseEnvFile(content: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const line of content.split("\n")) {
		const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
		if (!m) continue;
		out[m[1]] = m[2].trim().replace(/^(['"])(.*)\1$/, "$2");
	}
	return out;
}

export function expandHome(path: string, home: string = homedir()): string {
	if (path === "~") return home;
	return path.startsWith("~/") ? join(home, path.slice(2)) : path;
}

/**
 * App Store Connect API key. User config wins, then env `ASC_KEY_ID` /
 * `ASC_ISSUER_ID`, then `~/.appstoreconnect/env`. keyPath defaults to
 * `~/.appstoreconnect/private_keys/AuthKey_<id>.p8`. Returns null when the id
 * pair is incomplete. Key contents are never read.
 */
export function resolveAscKey(
	user: { keyId?: string; issuerId?: string; keyPath?: string } | undefined,
	env: Record<string, string | undefined> = process.env,
	home: string = homedir(),
): { keyId: string; issuerId: string; keyPath: string } | null {
	let file: Record<string, string> = {};
	const envFile = join(home, ".appstoreconnect", "env");
	if (existsSync(envFile)) {
		try {
			file = parseEnvFile(readFileSync(envFile, "utf-8"));
		} catch {
			// unreadable env file: fall through
		}
	}
	const keyId = user?.keyId || env.ASC_KEY_ID || file.ASC_KEY_ID;
	const issuerId = user?.issuerId || env.ASC_ISSUER_ID || file.ASC_ISSUER_ID;
	if (!keyId || !issuerId) return null;
	const keyPath = user?.keyPath
		? expandHome(user.keyPath, home)
		: join(home, ".appstoreconnect", "private_keys", `AuthKey_${keyId}.p8`);
	return { keyId, issuerId, keyPath };
}
