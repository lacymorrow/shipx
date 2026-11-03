import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResolvedConfig } from "../types.ts";

const calls: Array<{ file: string; args: string[]; cwd?: string }> = [];
let failOn: string | null = null;
const logged: string[] = [];

function record(file: string, args: string[], opts?: { cwd?: string }): string {
	calls.push({ file, args, cwd: opts?.cwd });
	return file === "git" ? "4\n" : "";
}

mock.module("../utils.ts", () => ({
	exec: record,
	run: async (file: string, args: string[], opts?: { cwd?: string }) => {
		const out = record(file, args, opts);
		if (failOn && args.includes(failOn)) {
			const err = new Error("boom") as Error & { stdout: string; stderr: string };
			err.stdout = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join("\n");
			err.stderr = "-----BEGIN PRIVATE KEY-----\nSECRETBYTES\n-----END PRIVATE KEY-----\nissuer-secret";
			throw err;
		}
		return out;
	},
	errorText: (err: unknown) => (err instanceof Error ? err.message : String(err)),
}));

mock.module("@clack/prompts", () => ({
	spinner: () => ({ start: () => {}, stop: () => {} }),
	log: {
		warn: (m: string) => logged.push(m),
		info: (m: string) => logged.push(m),
		error: (m: string) => logged.push(m),
		message: (m: string) => logged.push(m),
	},
}));

const x = await import("./xcode.ts");

let dir: string;
let keyPath: string;

function makeConfig(over: Partial<ResolvedConfig["xcode"]> = {}, top: Partial<ResolvedConfig> = {}): ResolvedConfig {
	return {
		root: dir,
		dryRun: false,
		steps: { commit: true, bumpVersion: true },
		xcode: {
			enabled: true,
			versionFile: "project.yml",
			buildNumber: "commitCount",
			buildNumberOffset: 9,
			generate: true,
			scheme: "CamFetti",
			platforms: ["ios"],
			exportOptionsPlist: "",
			ascKey: { keyId: "KEY123", issuerId: "issuer-secret", keyPath },
			upload: true,
			...over,
		},
		...top,
	} as unknown as ResolvedConfig;
}

beforeEach(() => {
	calls.length = 0;
	logged.length = 0;
	failOn = null;
	dir = mkdtempSync(join(tmpdir(), "shipx-xcode-step-"));
	keyPath = join(dir, "AuthKey_KEY123.p8");
	writeFileSync(keyPath, "not a real key");
	writeFileSync(join(dir, "project.yml"), "name: CamFetti\n");
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("command construction", () => {
	test("archive command matches the documented shape", () => {
		const cmd = x.archiveCommand(makeConfig(), "ios", 13);
		expect(cmd.file).toBe("xcodebuild");
		expect(cmd.args).toEqual([
			"-scheme", "CamFetti",
			"-configuration", "Release",
			"-destination", "generic/platform=iOS",
			"-archivePath", "build/CamFetti-ios-13.xcarchive",
			"CURRENT_PROJECT_VERSION=13",
			"-allowProvisioningUpdates",
			"-authenticationKeyPath", keyPath,
			"-authenticationKeyID", "KEY123",
			"-authenticationKeyIssuerID", "issuer-secret",
			"archive",
		]);
	});

	test("each platform maps to its generic destination", () => {
		const dests = (["ios", "macos", "tvos", "visionos"] as const).map((p) => {
			const a = x.archiveCommand(makeConfig(), p, 1).args;
			return a[a.indexOf("-destination") + 1];
		});
		expect(dests).toEqual(["generic/platform=iOS", "generic/platform=macOS", "generic/platform=tvOS", "generic/platform=visionOS"]);
	});

	test("without a key there are no auth flags", () => {
		const args = x.archiveCommand(makeConfig({ ascKey: null }), "ios", 1).args;
		expect(args.some((a) => a.startsWith("-authentication"))).toBe(false);
	});

	test("export command uses -exportArchive with the plist and export path", () => {
		const cmd = x.exportCommand(makeConfig(), "macos", 13);
		expect(cmd.args.slice(0, 7)).toEqual([
			"-exportArchive",
			"-archivePath", "build/CamFetti-macos-13.xcarchive",
			"-exportOptionsPlist", "build/shipx-export-options-macos.plist",
			"-exportPath", "build/CamFetti-macos-13-export",
		]);
		expect(cmd.args).toContain("-authenticationKeyID");
	});

	test("default export options set destination and keep our build number", () => {
		const up = x.defaultExportOptions(true);
		expect(up).toContain("<string>app-store-connect</string>");
		expect(up).toContain("<key>destination</key>\n\t<string>upload</string>");
		expect(up).toContain("<key>manageAppVersionAndBuildNumber</key>\n\t<false/>");
		expect(x.defaultExportOptions(false)).toContain("<string>export</string>");
	});

	test("shellQuote quotes only what needs it", () => {
		expect(x.shellQuote("a", ["b", "c d", "it's"])).toBe("a b 'c d' 'it'\\''s'");
	});
});

describe("redaction and readiness", () => {
	test("redactSecrets removes PEM blocks and key ids", () => {
		const out = x.redactSecrets("a -----BEGIN PRIVATE KEY-----\nXX\n-----END PRIVATE KEY----- KEY123 issuer-secret", makeConfig());
		expect(out).not.toContain("XX");
		expect(out).not.toContain("KEY123");
		expect(out).not.toContain("issuer-secret");
	});

	test("upload without a key is refused, --no-upload is fine", () => {
		const config = makeConfig({ ascKey: null });
		expect(x.checkXcodeReady(config, true)).toMatch(/No App Store Connect key/);
		expect(x.checkXcodeReady(config, false)).toBeNull();
	});

	test("isUploadEnabled honours config and the flag", () => {
		expect(x.isUploadEnabled(makeConfig(), false)).toBe(true);
		expect(x.isUploadEnabled(makeConfig(), true)).toBe(false);
		expect(x.isUploadEnabled(makeConfig({ upload: false }), false)).toBe(false);
	});
});

describe("runXcode", () => {
	test("dry run prints commands and runs nothing", async () => {
		await x.runXcode(makeConfig({}, { dryRun: true }));
		expect(calls.filter((c) => c.file === "xcodebuild")).toHaveLength(0);
		const text = logged.join("\n");
		expect(text).toContain("xcodegen generate");
		expect(text).toContain("CURRENT_PROJECT_VERSION=14");
		expect(text).toContain("-exportArchive");
	});

	test("real run: generate, archive, export, in order, with a plist on disk", async () => {
		await x.runXcode(makeConfig());
		expect(calls.filter((c) => c.file !== "git").map((c) => `${c.file}:${c.args[0]}`)).toEqual([
			"xcodegen:generate",
			"xcodebuild:-scheme",
			"xcodebuild:-exportArchive",
		]);
		// 4 commits + offset 9, release commit already counted
		expect(calls.find((c) => c.file === "xcodebuild")!.args).toContain("CURRENT_PROJECT_VERSION=13");
		const plist = readFileSync(join(dir, "build/shipx-export-options-ios.plist"), "utf-8");
		expect(plist).toContain("<string>upload</string>");
		expect(existsSync(join(dir, "build/shipx-logs/CamFetti-ios-13-archive.log"))).toBe(true);
	});

	test("noUpload exports without uploading", async () => {
		await x.runXcode(makeConfig({ ascKey: null }), { noUpload: true });
		const plist = readFileSync(join(dir, "build/shipx-export-options-ios.plist"), "utf-8");
		expect(plist).toContain("<string>export</string>");
		expect(calls.at(-1)!.args).not.toContain("-authenticationKeyID");
	});

	test("skips xcodegen without project.yml or with generate off", async () => {
		await x.runXcode(makeConfig({ generate: false }));
		expect(calls.some((c) => c.file === "xcodegen")).toBe(false);
	});

	test("a custom plist is copied and its destination set with plutil", async () => {
		writeFileSync(join(dir, "My.plist"), "<plist/>");
		await x.runXcode(makeConfig({ exportOptionsPlist: "My.plist" }));
		const plutil = calls.find((c) => c.file === "plutil")!;
		expect(plutil.args).toEqual(["-replace", "destination", "-string", "upload", "build/shipx-export-options-ios.plist"]);
		expect(readFileSync(join(dir, "build/shipx-export-options-ios.plist"), "utf-8")).toBe("<plist/>");
	});

	test("a failed archive prints the last 30 log lines, saves the log, redacts secrets, and throws", async () => {
		failOn = "archive";
		await expect(x.runXcode(makeConfig())).rejects.toThrow(/Archive CamFetti/);
		const shown = logged.join("\n");
		expect(shown).toContain("line 50");
		expect(shown).not.toContain("line 15");
		expect(shown).not.toContain("SECRETBYTES");
		expect(shown).not.toContain("issuer-secret");
		const log = readFileSync(join(dir, "build/shipx-logs/CamFetti-ios-13-archive.log"), "utf-8");
		expect(log).toContain("line 1");
		expect(log).not.toContain("SECRETBYTES");
		expect(calls.some((c) => c.args[0] === "-exportArchive")).toBe(false);
	});

	test("refuses to start an upload without a key", async () => {
		await expect(x.runXcode(makeConfig({ ascKey: null }))).rejects.toThrow(/App Store Connect key/);
		expect(calls.some((c) => c.file === "xcodebuild")).toBe(false);
	});
});
