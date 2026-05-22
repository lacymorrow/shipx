import * as p from "@clack/prompts";
import pc from "picocolors";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolve } from "node:path";
import type { ResolvedConfig } from "../types.ts";
import { detectDefaultBranch, errorText, exec } from "../utils.ts";
import { updateFormulaUrlAndSha } from "./homebrew-formula.ts";

export async function publishHomebrew(
	config: ResolvedConfig,
	tag: string,
	options?: { skipConfirm?: boolean },
): Promise<void> {
	const { tapPath, formulaFile, repoSlug, commitMessage } = config.homebrew;

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

	const spinner = p.spinner();
	spinner.start("Updating Homebrew formula");

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

		const tarballUrl = `https://github.com/${repoSlug}/archive/refs/tags/${tag}.tar.gz`;
		const tmpFile = join(tmpdir(), `shipx-tarball-${Date.now()}.tar.gz`);
		let sha256: string;
		try {
			// `-f`: fail on HTTP errors (404 for an unpushed tag, 5xx from
			// GitHub) instead of silently writing the error body into the
			// tarball — which would otherwise be hashed and committed.
			exec("curl", ["-fsLo", tmpFile, tarballUrl]);
			const tarball = readFileSync(tmpFile);
			sha256 = createHash("sha256").update(tarball).digest("hex");
		} catch (dlErr) {
			spinner.stop(pc.red("Failed to download tarball"));
			p.log.error(errorText(dlErr));
			try { unlinkSync(tmpFile); } catch {}
			return;
		}
		try { unlinkSync(tmpFile); } catch {}

		if (!sha256 || sha256.length !== 64) {
			spinner.stop(pc.red("Failed to compute SHA256"));
			p.log.error(`Got: ${sha256}`);
			return;
		}

		const formula = readFileSync(formulaPath, "utf-8");
		let updatedFormula: string;
		try {
			updatedFormula = updateFormulaUrlAndSha(formula, tarballUrl, sha256);
		} catch (replaceErr) {
			spinner.stop(pc.red("Homebrew formula replacement failed"));
			p.log.error(errorText(replaceErr));
			p.log.info(`Update manually: ${pc.cyan(`edit ${formulaPath}`)}`);
			return;
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
