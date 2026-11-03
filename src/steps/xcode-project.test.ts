import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../config.ts";
import {
	computeBuildNumber,
	detectScheme,
	detectVersionFile,
	isXcodeProject,
	readMarketingVersion,
	readSetting,
	readStoredBuildNumber,
	resolveAscKey,
	writeMarketingVersion,
	writeSetting,
	writeStoredBuildNumber,
} from "./xcode-project.ts";

const PROJECT_YML = `name: CamFetti
options:
  bundleIdPrefix: sh.lacy
settings:
  base:
    DEVELOPMENT_TEAM: ABC123
    MARKETING_VERSION: "1.0.0"
    CURRENT_PROJECT_VERSION: "1"
targets:
  Watch:
    settings:
      base:
        MARKETING_VERSION: '1.0.0'
`;

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "shipx-xcode-test-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function git(...args: string[]): string {
	return execFileSync("git", args, { cwd: dir, encoding: "utf-8" });
}

describe("version read/write", () => {
	test("reads MARKETING_VERSION from project.yml", () => {
		expect(readSetting(PROJECT_YML, "project.yml", "MARKETING_VERSION")).toBe("1.0.0");
	});

	test("rewrites every occurrence in project.yml and keeps the quote style", () => {
		const out = writeSetting(PROJECT_YML, "project.yml", "MARKETING_VERSION", "1.2.3")!;
		expect(out).toContain('    MARKETING_VERSION: "1.2.3"');
		expect(out).toContain("        MARKETING_VERSION: '1.2.3'");
		expect(out).toContain('CURRENT_PROJECT_VERSION: "1"');
	});

	test("quotes an unquoted yaml value", () => {
		const out = writeSetting("  MARKETING_VERSION: 1.0.0\n", "project.yml", "MARKETING_VERSION", "2.0.0");
		expect(out).toBe('  MARKETING_VERSION: "2.0.0"\n');
	});

	test("returns null when the key is missing", () => {
		expect(readSetting("name: x\n", "project.yml", "MARKETING_VERSION")).toBeNull();
		expect(writeSetting("name: x\n", "project.yml", "MARKETING_VERSION", "1.0.0")).toBeNull();
	});

	test("reads and writes a .xcconfig, leaving comments alone", () => {
		const xc = "// Version\nMARKETING_VERSION = 3.4.5 // shipped\nCURRENT_PROJECT_VERSION=7\n";
		expect(readSetting(xc, "Config/Base.xcconfig", "MARKETING_VERSION")).toBe("3.4.5");
		expect(readSetting(xc, "Config/Base.xcconfig", "CURRENT_PROJECT_VERSION")).toBe("7");
		const out = writeSetting(xc, "Config/Base.xcconfig", "MARKETING_VERSION", "3.5.0")!;
		expect(out).toBe("// Version\nMARKETING_VERSION = 3.5.0 // shipped\nCURRENT_PROJECT_VERSION=7\n");
	});

	test("file helpers round-trip on disk", () => {
		writeFileSync(join(dir, "project.yml"), PROJECT_YML);
		expect(readMarketingVersion(dir, "project.yml")).toBe("1.0.0");
		expect(writeMarketingVersion(dir, "project.yml", "1.0.1")).toBe(true);
		expect(readMarketingVersion(dir, "project.yml")).toBe("1.0.1");
		expect(writeStoredBuildNumber(dir, "project.yml", 42)).toBe(true);
		expect(readStoredBuildNumber(dir, "project.yml")).toBe(42);
		expect(readFileSync(join(dir, "project.yml"), "utf-8")).toContain('CURRENT_PROJECT_VERSION: "42"');
	});

	test("missing file reads as null and writes as false", () => {
		expect(readMarketingVersion(dir, "nope.xcconfig")).toBeNull();
		expect(writeMarketingVersion(dir, "nope.xcconfig", "1.0.0")).toBe(false);
	});
});

describe("build number", () => {
	function repoWithCommits(n: number): void {
		git("init", "-q");
		git("config", "user.email", "t@example.com");
		git("config", "user.name", "t");
		for (let i = 0; i < n; i++) {
			writeFileSync(join(dir, "f.txt"), String(i));
			git("add", "f.txt");
			git("commit", "-q", "-m", `c${i}`, "--no-verify");
		}
	}

	test("commitCount is the commit count plus the offset", () => {
		repoWithCommits(3);
		const x = { buildNumber: "commitCount" as const, buildNumberOffset: 9, versionFile: "" };
		expect(computeBuildNumber(dir, x)).toBe(12);
		expect(computeBuildNumber(dir, x, { pendingCommits: 1 })).toBe(13);
	});

	test("increment reads the stored value, plus one unless already bumped", () => {
		writeFileSync(join(dir, "project.yml"), PROJECT_YML);
		const x = { buildNumber: "increment" as const, buildNumberOffset: 0, versionFile: "project.yml" };
		expect(computeBuildNumber(dir, x)).toBe(2);
		expect(computeBuildNumber(dir, x, { alreadyBumped: true })).toBe(1);
	});

	test("increment without CURRENT_PROJECT_VERSION throws", () => {
		writeFileSync(join(dir, "project.yml"), "name: x\n");
		const x = { buildNumber: "increment" as const, buildNumberOffset: 0, versionFile: "project.yml" };
		expect(() => computeBuildNumber(dir, x)).toThrow(/CURRENT_PROJECT_VERSION/);
	});
});

describe("detection", () => {
	test("project.yml without package.json is an Xcode project", () => {
		writeFileSync(join(dir, "project.yml"), PROJECT_YML);
		expect(isXcodeProject(dir)).toBe(true);
		expect(detectVersionFile(dir)).toBe("project.yml");
		expect(detectScheme(dir)).toBe("CamFetti");
	});

	test("an .xcodeproj directory is an Xcode project and names the scheme", () => {
		mkdirSync(join(dir, "Thing.xcodeproj"));
		expect(isXcodeProject(dir)).toBe(true);
		expect(detectVersionFile(dir)).toBe("");
		expect(detectScheme(dir)).toBe("Thing");
	});

	test("a package.json repo is not an Xcode project", () => {
		writeFileSync(join(dir, "project.yml"), PROJECT_YML);
		writeFileSync(join(dir, "package.json"), "{}");
		expect(isXcodeProject(dir)).toBe(false);
	});

	test("loadConfig leaves packageJsonPaths empty and fills Xcode defaults", async () => {
		writeFileSync(join(dir, "project.yml"), PROJECT_YML);
		const config = await loadConfig(dir);
		expect(config.xcode.enabled).toBe(true);
		expect(config.packageJsonPaths).toEqual([]);
		expect(config.xcode.versionFile).toBe("project.yml");
		expect(config.xcode.scheme).toBe("CamFetti");
		expect(config.xcode.platforms).toEqual(["ios"]);
		expect(config.xcode.buildNumber).toBe("commitCount");
		expect(config.xcode.upload).toBe(true);
	});

	test("loadConfig leaves a plain npm repo alone", async () => {
		writeFileSync(join(dir, "package.json"), '{"name":"x","version":"1.0.0"}');
		const config = await loadConfig(dir);
		expect(config.xcode.enabled).toBe(false);
		expect(config.packageJsonPaths).toEqual(["package.json"]);
	});
});

describe("resolveAscKey", () => {
	test("env wins over the env file, and keyPath defaults from the key id", () => {
		mkdirSync(join(dir, ".appstoreconnect"));
		writeFileSync(join(dir, ".appstoreconnect", "env"), "export ASC_KEY_ID=FILEKEY\nexport ASC_ISSUER_ID='file-issuer'\n");
		const key = resolveAscKey(undefined, { ASC_KEY_ID: "ENVKEY" }, dir);
		expect(key).toEqual({
			keyId: "ENVKEY",
			issuerId: "file-issuer",
			keyPath: join(dir, ".appstoreconnect", "private_keys", "AuthKey_ENVKEY.p8"),
		});
	});

	test("explicit config wins and expands ~", () => {
		const key = resolveAscKey({ keyId: "K", issuerId: "I", keyPath: "~/keys/k.p8" }, {}, dir);
		expect(key).toEqual({ keyId: "K", issuerId: "I", keyPath: join(dir, "keys", "k.p8") });
	});

	test("returns null when the id pair is incomplete", () => {
		expect(resolveAscKey(undefined, { ASC_KEY_ID: "K" }, dir)).toBeNull();
	});
});
