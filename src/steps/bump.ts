import * as p from "@clack/prompts";
import pc from "picocolors";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ResolvedConfig } from "../types.ts";
import { readJson, writeJson } from "../utils.ts";

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
		writeFileSync(abs, updated);
		bumped.push(fileConfig.path);
	}

	const fileList = bumped.map((f) => pc.cyan(f)).join(", ");
	spinner.stop(`Bumped ${fileList} → ${pc.green(newVersion)}`);
}

export function getFilesToStage(config: ResolvedConfig): string[] {
	const files: string[] = [...config.packageJsonPaths];
	for (const f of config.bumpFiles) {
		files.push(f.path);
	}
	return files;
}
