import * as p from "@clack/prompts";
import pc from "picocolors";
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import type { ResolvedConfig, XcodePlatform } from "../types.ts";
import { errorText, exec, run } from "../utils.ts";
import { computeBuildNumber, XCODE_PLATFORM_DESTINATIONS } from "./xcode-project.ts";

export interface XcodeCommand {
	label: string;
	file: string;
	args: string[];
	/** Log file stem under build/shipx-logs/, empty when the command is not logged */
	logName: string;
}

function authArgs(config: ResolvedConfig): string[] {
	const key = config.xcode.ascKey;
	if (!key) return [];
	return [
		"-authenticationKeyPath", key.keyPath,
		"-authenticationKeyID", key.keyId,
		"-authenticationKeyIssuerID", key.issuerId,
	];
}

export function archivePathFor(config: ResolvedConfig, platform: XcodePlatform, build: number): string {
	return `build/${config.xcode.scheme}-${platform}-${build}.xcarchive`;
}

export function exportPathFor(config: ResolvedConfig, platform: XcodePlatform, build: number): string {
	return `build/${config.xcode.scheme}-${platform}-${build}-export`;
}

export function exportOptionsPathFor(platform: XcodePlatform): string {
	return `build/shipx-export-options-${platform}.plist`;
}

export function archiveCommand(config: ResolvedConfig, platform: XcodePlatform, build: number): XcodeCommand {
	const { scheme } = config.xcode;
	return {
		label: `Archive ${scheme} (${platform})`,
		file: "xcodebuild",
		args: [
			"-scheme", scheme,
			"-configuration", "Release",
			"-destination", XCODE_PLATFORM_DESTINATIONS[platform],
			"-archivePath", archivePathFor(config, platform, build),
			`CURRENT_PROJECT_VERSION=${build}`,
			// No registered device for this platform: archive unsigned, the export signs it.
			...(config.xcode.unsignedArchive.includes(platform) ? ["CODE_SIGNING_ALLOWED=NO"] : []),
			"-allowProvisioningUpdates",
			...authArgs(config),
			"archive",
		],
		logName: `${scheme}-${platform}-${build}-archive`,
	};
}

export function exportCommand(config: ResolvedConfig, platform: XcodePlatform, build: number): XcodeCommand {
	const { scheme } = config.xcode;
	return {
		label: `Export ${scheme} (${platform})`,
		file: "xcodebuild",
		args: [
			"-exportArchive",
			"-archivePath", archivePathFor(config, platform, build),
			"-exportOptionsPlist", exportOptionsPathFor(platform),
			"-exportPath", exportPathFor(config, platform, build),
			"-allowProvisioningUpdates",
			...authArgs(config),
		],
		logName: `${scheme}-${platform}-${build}-export`,
	};
}

/** Default export options: App Store Connect, we own the build number. */
export function defaultExportOptions(upload: boolean): string {
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>method</key>
	<string>app-store-connect</string>
	<key>destination</key>
	<string>${upload ? "upload" : "export"}</string>
	<key>manageAppVersionAndBuildNumber</key>
	<false/>
	<key>signingStyle</key>
	<string>automatic</string>
	<key>uploadSymbols</key>
	<true/>
</dict>
</plist>
`;
}

/** Commands that put the export options in place: a generated file, or the user's plist with `destination` set. */
function exportOptionsSteps(config: ResolvedConfig, platform: XcodePlatform, upload: boolean): XcodeCommand[] {
	if (!config.xcode.exportOptionsPlist) return [];
	const target = exportOptionsPathFor(platform);
	return [{
		label: `Set export destination (${platform})`,
		file: "plutil",
		args: ["-replace", "destination", "-string", upload ? "upload" : "export", target],
		logName: "",
	}];
}

export function shellQuote(file: string, args: string[]): string {
	return [file, ...args].map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, "'\\''")}'`)).join(" ");
}

/** Strip anything that looks like key material before it reaches the terminal or a PR. */
export function redactSecrets(text: string, config?: ResolvedConfig): string {
	let out = text.replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[redacted key]");
	const key = config?.xcode.ascKey;
	if (key) {
		for (const secret of [key.keyId, key.issuerId]) {
			if (secret) out = out.split(secret).join("***");
		}
	}
	return out;
}

export function lastLines(text: string, count: number): string {
	return text.replace(/\n+$/, "").split("\n").slice(-count).join("\n");
}

function failureText(err: unknown): string {
	const parts: string[] = [];
	if (err && typeof err === "object") {
		const e = err as { stdout?: unknown; stderr?: unknown };
		if (typeof e.stdout === "string") parts.push(e.stdout);
		if (typeof e.stderr === "string") parts.push(e.stderr);
	}
	if (!parts.join("").trim()) parts.push(errorText(err));
	return parts.join("\n");
}

function writeLog(config: ResolvedConfig, name: string, content: string): string {
	const dir = resolve(config.root, "build", "shipx-logs");
	mkdirSync(dir, { recursive: true });
	const file = join(dir, `${name}.log`);
	writeFileSync(file, redactSecrets(content, config));
	return relative(config.root, file);
}

export class XcodeStepError extends Error {}

async function runLogged(config: ResolvedConfig, cmd: XcodeCommand, doneLabel: string): Promise<void> {
	const spinner = p.spinner();
	spinner.start(cmd.label);
	try {
		const out = await run(cmd.file, cmd.args, { cwd: config.root });
		if (cmd.logName) writeLog(config, cmd.logName, out);
		spinner.stop(doneLabel);
	} catch (err) {
		const text = failureText(err);
		const logFile = cmd.logName ? writeLog(config, cmd.logName, text) : "";
		spinner.stop(pc.red(`${cmd.label} failed`));
		p.log.error(redactSecrets(lastLines(text, 30), config));
		if (logFile) p.log.info(`Full log: ${pc.cyan(logFile)}`);
		throw new XcodeStepError(`${cmd.label} failed`);
	}
}

function prepareExportOptions(config: ResolvedConfig, platform: XcodePlatform, upload: boolean): void {
	const target = resolve(config.root, exportOptionsPathFor(platform));
	mkdirSync(resolve(config.root, "build"), { recursive: true });
	if (config.xcode.exportOptionsPlist) {
		copyFileSync(resolve(config.root, config.xcode.exportOptionsPlist), target);
	} else {
		writeFileSync(target, defaultExportOptions(upload));
	}
}

/** Pre-run checks. Returns an error message or null. */
export function checkXcodeReady(config: ResolvedConfig, upload: boolean): string | null {
	const x = config.xcode;
	if (!x.scheme) return "No Xcode scheme found. Set xcode.scheme in the shipx config.";
	if (!x.platforms.length) return "xcode.platforms is empty.";
	if (upload && !x.ascKey) {
		return "No App Store Connect key. Set ASC_KEY_ID and ASC_ISSUER_ID (or ~/.appstoreconnect/env, or xcode.ascKey), or pass --no-upload.";
	}
	if (x.ascKey && !existsSync(x.ascKey.keyPath)) {
		return `App Store Connect key file not found: ${x.ascKey.keyPath}`;
	}
	if (x.exportOptionsPlist && !existsSync(resolve(config.root, x.exportOptionsPlist))) {
		return `xcode.exportOptionsPlist not found: ${x.exportOptionsPlist}`;
	}
	return null;
}

export function isUploadEnabled(config: ResolvedConfig, noUploadFlag: boolean): boolean {
	return config.xcode.upload && !noUploadFlag;
}

/**
 * Build number to use now. A dry run has not made the release commit yet, so
 * a commit-count number is one short there.
 */
export function currentBuildNumber(config: ResolvedConfig): number {
	return computeBuildNumber(config.root, config.xcode, {
		pendingCommits: config.dryRun && config.steps.commit ? 1 : 0,
		alreadyBumped: !config.dryRun && config.steps.bumpVersion,
	});
}

export async function runXcode(config: ResolvedConfig, opts: { noUpload?: boolean } = {}): Promise<void> {
	const x = config.xcode;
	const upload = isUploadEnabled(config, opts.noUpload === true);

	const problem = checkXcodeReady(config, upload);
	if (problem) {
		if (config.dryRun) p.log.warn(`${pc.dim("[dry-run]")} ${problem}`);
		else throw new XcodeStepError(problem);
	}

	const build = currentBuildNumber(config);
	const generateNeeded = x.generate && existsSync(resolve(config.root, "project.yml"));

	if (config.dryRun) {
		p.log.info(`${pc.dim("[dry-run]")} Xcode: scheme ${pc.cyan(x.scheme)}, build ${pc.green(String(build))}, ${upload ? "upload to App Store Connect" : "no upload"}`);
		p.log.message(`  ${pc.dim("export options:")} ${x.exportOptionsPlist ? x.exportOptionsPlist : "generated app-store-connect plist"}, destination ${upload ? "upload" : "export"}`);
		if (generateNeeded) p.log.message(`  ${pc.dim("$")} ${shellQuote("xcodegen", ["generate"])}`);
		for (const platform of x.platforms) {
			const steps = [
				archiveCommand(config, platform, build),
				...exportOptionsSteps(config, platform, upload),
				exportCommand(config, platform, build),
			];
			if (x.exportOptionsPlist) {
				p.log.message(`  ${pc.dim("$")} ${shellQuote("cp", [x.exportOptionsPlist, exportOptionsPathFor(platform)])}`);
			}
			for (const cmd of steps) {
				p.log.message(`  ${pc.dim("$")} ${shellQuote(cmd.file, cmd.args)}`);
			}
		}
		return;
	}

	if (generateNeeded) {
		const spinner = p.spinner();
		spinner.start("Generating Xcode project");
		try {
			await run("xcodegen", ["generate"], { cwd: config.root });
			spinner.stop("Generated Xcode project");
		} catch (err) {
			spinner.stop(pc.red("xcodegen generate failed"));
			p.log.error(redactSecrets(lastLines(failureText(err), 30), config));
			throw new XcodeStepError("xcodegen generate failed");
		}
	}

	if (!existsSync(resolve(config.root, "build"))) mkdirSync(resolve(config.root, "build"), { recursive: true });

	for (const platform of x.platforms) {
		await runLogged(config, archiveCommand(config, platform, build), `Archived ${x.scheme} (${platform}) build ${build}`);
		prepareExportOptions(config, platform, upload);
		for (const cmd of exportOptionsSteps(config, platform, upload)) {
			exec(cmd.file, cmd.args, { cwd: config.root });
		}
		await runLogged(
			config,
			exportCommand(config, platform, build),
			upload
				? `Uploaded ${x.scheme} (${platform}) build ${build} to App Store Connect`
				: `Exported ${x.scheme} (${platform}) build ${build} to ${exportPathFor(config, platform, build)}`,
		);
	}
}
