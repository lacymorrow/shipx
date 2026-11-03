import * as p from "@clack/prompts";
import pc from "picocolors";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ResolvedConfig } from "../types.ts";
import { readJson, writeJson } from "../utils.ts";
import { computeBuildNumber, writeMarketingVersion, writeStoredBuildNumber } from "./xcode-project.ts";

export function bumpVersionFiles(
	config: ResolvedConfig,
	newVersion: string,
): void {
	const spinner = p.spinner();
	spinner.start("Bumping version files");

	const bumped: string[] = [];

	for (const rel of config.packageJsonPaths) {
		const abs = resolve(config.root, rel);
		if (!existsSync(abs)) {
			p.log.warn(`package.json not found: ${abs}`);
			continue;
		}
		const pkg = readJson(abs);
		pkg.version = newVersion;
		writeJson(abs, pkg);
		bumped.push(rel);
	}

	if (config.xcode.enabled && config.xcode.versionFile) {
		const { versionFile } = config.xcode;
		// MARKETING_VERSION is x.y.z only; App Store Connect rejects a -beta suffix.
		const marketing = newVersion.replace(/-.*$/, "");
		if (writeMarketingVersion(config.root, versionFile, marketing)) {
			bumped.push(versionFile);
			if (config.xcode.buildNumber === "increment") {
				const next = computeBuildNumber(config.root, config.xcode);
				writeStoredBuildNumber(config.root, versionFile, next);
			}
		} else {
			p.log.warn(`MARKETING_VERSION not found in ${pc.cyan(versionFile)} — file unchanged`);
		}
	}

	for (const fileConfig of config.bumpFiles) {
		const abs = resolve(config.root, fileConfig.path);
		if (!existsSync(abs)) {
			p.log.warn(`File not found: ${abs}`);
			continue;
		}
		const content = readFileSync(abs, "utf-8");
		const updated = content.replace(
			fileConfig.pattern,
			fileConfig.replacement(newVersion),
		);
		if (updated === content) {
			// Pattern didn't match — silently writing the unchanged file would
			// leave a stale version in this file while still staging it for
			// commit, masking the misconfiguration until users notice later.
			p.log.warn(
				`bumpFiles: pattern ${pc.dim(String(fileConfig.pattern))} did not match in ${pc.cyan(fileConfig.path)} — file unchanged`,
			);
			continue;
		}
		writeFileSync(abs, updated);
		bumped.push(fileConfig.path);
	}

	const fileList = bumped.map((f) => pc.cyan(f)).join(", ");
	spinner.stop(`Bumped ${fileList} → ${pc.green(newVersion)}`);
}

export function getFilesToStage(config: ResolvedConfig): string[] {
	const files: string[] = [...config.packageJsonPaths];
	if (config.xcode.enabled && config.xcode.versionFile && !files.includes(config.xcode.versionFile)) {
		files.push(config.xcode.versionFile);
	}
	for (const f of config.bumpFiles) {
		files.push(f.path);
	}
	return files;
}
