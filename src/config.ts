import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { detectPublishTarget } from "./detect.ts";
import type { ResolvedConfig, ShipConfig } from "./types.ts";
import { detectDefaultBranch, exec, readJson } from "./utils.ts";

/**
 * Normalize a flags option that the user may supply as either a string
 * (whitespace-split) or a pre-tokenized array. The array form is preferred
 * because it preserves quoted arguments verbatim; whitespace-splitting a
 * string like `-m "release: v1"` breaks the argument into 3 pieces.
 */
export function normalizeFlags(input: string | string[] | undefined): string[] {
	if (input === undefined) return [];
	if (Array.isArray(input)) return input.filter((s) => s.length > 0);
	return input.split(/\s+/).filter(Boolean);
}

const DEFAULTS: Omit<ResolvedConfig, "root"> = {
	packageJsonPaths: [],
	versionSource: "",
	bumpFiles: [],
	cargoWorkspaces: [],
	dryRun: false,
	anyBranch: false,
	tag: "",
	testScript: "test",
	steps: {
		preflight: true,
		test: false,
		cleanup: false,
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
		commitFlags: ["--no-verify"],
		pushFlags: ["--no-verify"],
	},
	github: {
		draft: false,
		assets: [],
	},
	npm: {
		cwd: "",
		access: "public",
		targets: [],
		autoDetectedReason: "",
	},
	homebrew: {
		tapPath: "",
		formulaFile: "",
		repoSlug: "",
		commitMessage: "{formula}: update to {tag}",
		binaryAssets: {},
	},
	hooks: {},
};

function mergeConfig(base: Omit<ResolvedConfig, "root">, user: ShipConfig): Omit<ResolvedConfig, "root"> {
	return {
		packageJsonPaths: user.packageJsonPaths ?? base.packageJsonPaths,
		versionSource: user.versionSource ?? base.versionSource,
		bumpFiles: user.bumpFiles ?? base.bumpFiles,
		cargoWorkspaces: user.cargoWorkspaces ?? base.cargoWorkspaces,
		dryRun: base.dryRun,
		anyBranch: base.anyBranch,
		tag: base.tag,
		testScript: user.testScript ?? base.testScript,
		steps: { ...base.steps, ...user.steps },
		git: {
			...base.git,
			...user.git,
			commitFlags: user.git?.commitFlags === undefined
				? base.git.commitFlags
				: normalizeFlags(user.git.commitFlags),
			pushFlags: user.git?.pushFlags === undefined
				? base.git.pushFlags
				: normalizeFlags(user.git.pushFlags),
		},
		github: { ...base.github, ...user.github },
		npm: {
			cwd: user.npm?.cwd ?? base.npm.cwd,
			access: user.npm?.access ?? base.npm.access,
			targets: [], // resolved in loadConfig after cwd is finalized
			autoDetectedReason: "",
		},
		homebrew: {
			...base.homebrew,
			...user.homebrew,
			binaryAssets: user.homebrew?.binaryAssets ?? base.homebrew.binaryAssets,
		},
		hooks: { ...base.hooks, ...user.hooks },
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

	const userSetCwd = typeof userConfig.npm?.cwd === "string" && userConfig.npm.cwd.length > 0;
	const userSetTargets = (userConfig.npm?.targets?.length ?? 0) > 0;
	const userSetPackageJsonPaths = (userConfig.packageJsonPaths?.length ?? 0) > 0;
	const userSetVersionSource = typeof userConfig.versionSource === "string" && userConfig.versionSource.length > 0;

	// Try auto-detection only when the user gave us no publish-target hint
	// (no npm.cwd, no npm.targets). The detector is conservative: it only
	// picks a subpackage when the root package.json is clearly unpublishable
	// (private, workspace root, or no entry points).
	let detectedRelativePath: string | null = null;
	if (!merged.npm.cwd) {
		if (!userSetCwd && !userSetTargets) {
			const detected = detectPublishTarget(root);
			if (detected.target) {
				merged.npm.cwd = detected.target.cwd;
				merged.npm.autoDetectedReason = `auto-detected npm.cwd → ${detected.target.relativePath} (${detected.reason})`;
				detectedRelativePath = detected.target.relativePath;
			} else if (detected.ambiguousCandidates && detected.ambiguousCandidates.length > 0) {
				// Ambiguous: don't pick one silently. Fall back to root and
				// record the ambiguity so preflight can warn loudly.
				merged.npm.cwd = root;
				merged.npm.autoDetectedReason = `${detected.reason}. Candidates: ${detected.ambiguousCandidates.map((c) => c.relativePath).join(", ")}`;
			} else {
				merged.npm.cwd = root;
			}
		} else {
			merged.npm.cwd = root;
		}
	} else {
		merged.npm.cwd = resolve(root, merged.npm.cwd);
	}

	// When auto-detection picked a subpackage as npm.cwd, that same package's
	// version field is what the registry will see — so default packageJsonPaths
	// and versionSource to it too, unless the user already configured them.
	// Without this, shipx would bump root/package.json and publish the
	// subpackage with a stale version.
	if (detectedRelativePath) {
		const subPath = `${detectedRelativePath}/package.json`;
		if (!userSetPackageJsonPaths) {
			merged.packageJsonPaths = existsSync(pkgPath)
				? [subPath, "package.json"]
				: [subPath];
		}
		if (!userSetVersionSource) {
			merged.versionSource = subPath;
		}
	}

	if (!merged.packageJsonPaths.length && existsSync(pkgPath)) {
		merged.packageJsonPaths = ["package.json"];
	}

	const userTargets = userConfig.npm?.targets;
	if (userTargets && userTargets.length > 0) {
		merged.npm.targets = userTargets.map((t) => ({
			cwd: t.cwd ? resolve(root, t.cwd) : merged.npm.cwd,
			access: t.access ?? merged.npm.access,
		}));
	} else {
		merged.npm.targets = [{ cwd: merged.npm.cwd, access: merged.npm.access }];
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

	if (userConfig.git?.releaseBranch === undefined) {
		merged.git.releaseBranch = detectDefaultBranch(root);
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
