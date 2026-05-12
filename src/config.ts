import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ResolvedConfig, ShipConfig } from "./types.ts";
import { exec, readJson } from "./utils.ts";

const DEFAULTS: Omit<ResolvedConfig, "root"> = {
	packageJsonPaths: [],
	bumpFiles: [],
	cargoWorkspaces: [],
	steps: {
		preflight: true,
		changelog: true,
		bumpVersion: true,
		commit: true,
		tag: true,
		push: true,
		githubRelease: true,
		npm: true,
		homebrew: true,
	},
	git: {
		releaseBranch: "main",
		tagPrefix: "v",
		extraTags: [],
		commitMessage: "release: {tag}",
		commitFlags: "--no-verify",
		pushFlags: "--no-verify",
	},
	npm: {
		cwd: "",
		access: "public",
	},
	homebrew: {
		tapPath: "",
		formulaFile: "",
		repoSlug: "",
		commitMessage: "{formula}: update to {tag}",
	},
};

function mergeConfig(base: Omit<ResolvedConfig, "root">, user: ShipConfig): Omit<ResolvedConfig, "root"> {
	return {
		packageJsonPaths: user.packageJsonPaths ?? base.packageJsonPaths,
		bumpFiles: user.bumpFiles ?? base.bumpFiles,
		cargoWorkspaces: user.cargoWorkspaces ?? base.cargoWorkspaces,
		steps: { ...base.steps, ...user.steps },
		git: { ...base.git, ...user.git },
		npm: { ...base.npm, ...user.npm },
		homebrew: { ...base.homebrew, ...user.homebrew },
	};
}

export async function loadConfig(root: string): Promise<ResolvedConfig> {
	let userConfig: ShipConfig = {};

	const candidates = [
		resolve(root, "shipx.config.ts"),
		resolve(root, "shipx.config.js"),
		resolve(root, ".shipxrc.json"),
		resolve(root, ".shipxrc"),
	];

	for (const candidate of candidates) {
		if (existsSync(candidate)) {
			if (candidate.endsWith(".ts") || candidate.endsWith(".js")) {
				const mod = await import(candidate);
				userConfig = mod.default ?? mod;
			} else {
				userConfig = JSON.parse(readFileSync(candidate, "utf-8"));
			}
			break;
		}
	}

	const pkgPath = resolve(root, "package.json");
	if (!Object.keys(userConfig).length && existsSync(pkgPath)) {
		const pkg = readJson(pkgPath);
		if (pkg.shipx && typeof pkg.shipx === "object") {
			userConfig = pkg.shipx as ShipConfig;
		}
	}

	const merged = mergeConfig(DEFAULTS, userConfig);

	if (!merged.packageJsonPaths.length && existsSync(pkgPath)) {
		merged.packageJsonPaths = ["package.json"];
	}

	if (!merged.npm.cwd) {
		merged.npm.cwd = root;
	}

	// Auto-detect Tauri workspace: if src-tauri/Cargo.toml exists and the user
	// hasn't explicitly configured cargoWorkspaces, add it automatically.
	// Gate on undefined so that cargoWorkspaces: [] can opt out of auto-detection.
	if (userConfig.cargoWorkspaces === undefined) {
		const srcTauri = resolve(root, "src-tauri");
		if (existsSync(resolve(srcTauri, "Cargo.toml"))) {
			merged.cargoWorkspaces = ["src-tauri"];
		}
	}

	if (!merged.homebrew.tapPath) {
		const siblingTap = resolve(root, "../homebrew-tap");
		if (existsSync(siblingTap)) {
			merged.homebrew.tapPath = siblingTap;
		}
	}

	if (merged.homebrew.tapPath && !merged.homebrew.formulaFile && !merged.homebrew.repoSlug) {
		try {
			const remote = exec("git", ["remote", "get-url", "origin"], { cwd: root }).trim();
			const match = remote.match(/github\.com[:/]([^/]+)\/([^/.]+)/);
			if (match) {
				merged.homebrew.repoSlug = `${match[1]}/${match[2]}`;
				merged.homebrew.formulaFile = `Formula/${match[2]}.rb`;
			}
		} catch {
			// no remote
		}
	}

	return { ...merged, root };
}
