import * as p from "@clack/prompts";
import pc from "picocolors";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolve } from "node:path";
import type { ResolvedConfig } from "../types.ts";
import { detectDefaultBranch, errorText, exec } from "../utils.ts";
import { updateFormulaUrlAndSha, updateBinaryFormulaAssets, type BinaryAssetInfo } from "./homebrew-formula.ts";

function downloadAndHash(url: string): string {
	const tmpFile = join(tmpdir(), `shipx-asset-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	try {
		exec("curl", ["-fsLo", tmpFile, url]);
		const data = readFileSync(tmpFile);
		return createHash("sha256").update(data).digest("hex");
	} finally {
		try { unlinkSync(tmpFile); } catch {}
	}
}

export async function publishHomebrew(
	config: ResolvedConfig,
	tag: string,
	options?: { skipConfirm?: boolean },
): Promise<void> {
	const { tapPath, formulaFile, repoSlug, commitMessage, binaryAssets } = config.homebrew;

	if (!tapPath || !formulaFile || !repoSlug) {
		p.log.warn("Homebrew config incomplete (tapPath, formulaFile, repoSlug required). Skipping.");
		return;
	}

	const formulaPath = resolve(tapPath, formulaFile);
	if (!existsSync(formulaPath)) {
		p.log.warn(`Homebrew formula not found at ${pc.dim(formulaPath)}. Skipping.`);
		return;
	}

	if (!options?.skipConfirm) {
		const doHomebrew = await p.confirm({
			message: "Update Homebrew formula?",
			initialValue: true,
		});
		if (p.isCancel(doHomebrew) || !doHomebrew) {
			p.log.info("Skipping Homebrew");
			return;
		}
	}

	const isBinaryMode = Object.keys(binaryAssets).length > 0;
	const modeLabel = isBinaryMode ? "binary" : "source";

	const spinner = p.spinner();
	spinner.start(`Updating Homebrew formula (${modeLabel} mode)`);

	try {
		const dirtyCheck = exec("git", ["status", "--porcelain"], { cwd: tapPath }).trim();
		if (dirtyCheck) {
			spinner.stop(pc.red("Homebrew tap has uncommitted changes"));
			p.log.error(`Clean up ${pc.dim(tapPath)} before updating the formula.`);
			return;
		}

		const branch = detectDefaultBranch(tapPath);
		exec("git", ["checkout", branch], { cwd: tapPath });
		exec("git", ["pull", "--rebase", "origin", branch], { cwd: tapPath });

		const formula = readFileSync(formulaPath, "utf-8");
		let updatedFormula: string;

		if (isBinaryMode) {
			const version = tag.replace(/^v/, "");
			const resolved: Record<string, BinaryAssetInfo> = {};

			for (const [platform, filenameTemplate] of Object.entries(binaryAssets)) {
				const filename = filenameTemplate
					.replace(/\{version\}/g, version)
					.replace(/\{tag\}/g, tag);
				const assetUrl = `https://github.com/${repoSlug}/releases/download/${tag}/${filename}`;

				spinner.message(`Downloading ${pc.dim(filename)}`);
				let sha256: string;
				try {
					sha256 = downloadAndHash(assetUrl);
				} catch (dlErr) {
					spinner.stop(pc.red(`Failed to download ${filename}`));
					p.log.error(errorText(dlErr));
					return;
				}

				if (!sha256 || sha256.length !== 64) {
					spinner.stop(pc.red(`Failed to compute SHA256 for ${filename}`));
					p.log.error(`Got: ${sha256}`);
					return;
				}

				resolved[platform] = { url: assetUrl, sha256 };
			}

			spinner.message("Updating formula");
			try {
				const result = updateBinaryFormulaAssets(formula, resolved);
				updatedFormula = result.formula;
				if (result.unmatchedPlatforms.length) {
					p.log.warn(
						`Formula had no matching block for: ${result.unmatchedPlatforms.map((k) => pc.yellow(k)).join(", ")}`,
					);
				}
			} catch (replaceErr) {
				spinner.stop(pc.red("Homebrew formula replacement failed"));
				p.log.error(errorText(replaceErr));
				p.log.info(`Update manually: ${pc.cyan(`edit ${formulaPath}`)}`);
				return;
			}
		} else {
			const tarballUrl = `https://github.com/${repoSlug}/archive/refs/tags/${tag}.tar.gz`;
			let sha256: string;
			try {
				sha256 = downloadAndHash(tarballUrl);
			} catch (dlErr) {
				spinner.stop(pc.red("Failed to download tarball"));
				p.log.error(errorText(dlErr));
				return;
			}

			if (!sha256 || sha256.length !== 64) {
				spinner.stop(pc.red("Failed to compute SHA256"));
				p.log.error(`Got: ${sha256}`);
				return;
			}

			try {
				updatedFormula = updateFormulaUrlAndSha(formula, tarballUrl, sha256);
			} catch (replaceErr) {
				spinner.stop(pc.red("Homebrew formula replacement failed"));
				p.log.error(errorText(replaceErr));
				p.log.info(`Update manually: ${pc.cyan(`edit ${formulaPath}`)}`);
				return;
			}
		}

		writeFileSync(formulaPath, updatedFormula);

		const formulaName = formulaFile.replace(/^Formula\//, "").replace(/\.rb$/, "");
		exec("git", ["add", formulaFile], { cwd: tapPath });

		const msg = commitMessage
			.replace(/\{tag\}/g, tag)
			.replace(/\{formula\}/g, formulaName);
		exec("git", ["commit", "-m", msg], { cwd: tapPath });
		exec("git", ["push"], { cwd: tapPath });

		spinner.stop(`Homebrew formula updated to ${pc.green(tag)}`);
	} catch (err) {
		spinner.stop(pc.red("Homebrew update failed"));
		p.log.error(errorText(err));
		p.log.info(`Update manually: ${pc.cyan(`edit ${formulaPath}`)}`);
	}
}
