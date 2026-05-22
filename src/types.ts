export interface BumpFileConfig {
	path: string;
	pattern: RegExp;
	replacement: (version: string) => string;
}

export interface NpmTarget {
	cwd: string;
	access: "public" | "restricted";
}

export interface ShipConfig {
	/** Paths to package.json files to version-bump (relative to project root) */
	packageJsonPaths?: string[];
	/**
	 * Path to the package.json whose `version` field is the source of truth
	 * for the current version (relative to project root).
	 * Useful in monorepos where the root package.json has no version.
	 * When omitted, defaults to `packageJsonPaths[0]`.
	 */
	versionSource?: string;
	/** Additional files with regex-based version bumping */
	bumpFiles?: BumpFileConfig[];
	/**
	 * Cargo workspace directories to version-bump via `cargo set-version --workspace`.
	 * Each path is relative to the project root and should contain a Cargo.toml.
	 * Auto-detected: if `src-tauri/Cargo.toml` exists and this is not configured, it is added automatically.
	 */
	cargoWorkspaces?: string[];
	/** Steps to run (all enabled by default) */
	steps?: {
		preflight?: boolean;
		test?: boolean;
		cleanup?: boolean;
		changelog?: boolean;
		bumpVersion?: boolean;
		commit?: boolean;
		tag?: boolean;
		push?: boolean;
		githubRelease?: boolean;
		npm?: boolean;
		homebrew?: boolean;
	};
	/** Test script to run. Default: 'test' (runs via npm/bun test) */
	testScript?: string;
	/** Git settings */
	git?: {
		/** Branch that must be current for stable releases. Default: 'main' */
		releaseBranch?: string;
		/** Tag prefix. Default: 'v' */
		tagPrefix?: string;
		/**
		 * Extra git tags to create and push alongside the main tag.
		 * Use `{tag}` for the full tag (e.g. `v0.5.3`) or `{version}` for the bare version.
		 * Example: `["cua-{tag}"]` creates `cua-v0.5.3` for Juno's juno-cua releases.
		 */
		extraTags?: string[];
		/** Commit message template. Use {tag} placeholder. Default: 'release: {tag}' */
		commitMessage?: string;
		/**
		 * Commit flags. Default: `["--no-verify"]`.
		 * Strings are accepted for backward compatibility but split on whitespace,
		 * which breaks for quoted arguments — prefer the array form when a flag
		 * value could contain spaces (e.g. `-m "release: v1"`).
		 */
		commitFlags?: string | string[];
		/**
		 * Push flags. Default: `["--no-verify"]`.
		 * See `commitFlags` for the string-vs-array tradeoff.
		 */
		pushFlags?: string | string[];
	};
	/** npm publish settings */
	npm?: {
		/** Working directory for npm publish. Default: project root */
		cwd?: string;
		/** npm publish access. Default: 'public' */
		access?: "public" | "restricted";
		/**
		 * Multiple npm publish targets. When set, each target is published
		 * separately with OTP collected once and reused across all targets.
		 * If omitted, a single target is synthesized from cwd/access.
		 */
		targets?: Array<{ cwd?: string; access?: "public" | "restricted" }>;
	};
	/** GitHub release settings */
	github?: {
		/** Create the release as a draft so you can review before publishing. Default: false */
		draft?: boolean;
		/**
		 * Glob patterns for files to upload as release assets.
		 * Resolved relative to the project root.
		 * Only `*` wildcards are supported (single directory level).
		 * `**`, `?`, brackets, and braces are not supported.
		 * Example: ["dist/*.zip", "dist/*.tar.gz"]
		 */
		assets?: string[];
	};
	/** Homebrew tap settings */
	homebrew?: {
		/** Absolute path to the homebrew tap directory */
		tapPath?: string;
		/** Path to the formula file, relative to tapPath */
		formulaFile?: string;
		/** GitHub repo slug for tarball URL (e.g. 'user/repo'). Auto-detected if omitted */
		repoSlug?: string;
		/** Commit message template. Use {tag} and {formula} placeholders */
		commitMessage?: string;
		/**
		 * Per-platform release asset filenames for pre-built binary formulas.
		 * When set, downloads each platform asset from the GitHub release and computes
		 * per-platform SHA256 hashes instead of downloading a single source tarball.
		 *
		 * Keys: "darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"
		 * Values: asset filename. Use {version} for bare version, {tag} for prefixed tag.
		 *
		 * The formula must use on_macos/on_linux blocks with Hardware::CPU conditionals
		 * containing paired url + sha256 lines.
		 */
		binaryAssets?: Record<string, string>;
	};
}

export interface ResolvedGitConfig {
	releaseBranch: string;
	tagPrefix: string;
	extraTags: string[];
	commitMessage: string;
	commitFlags: string[];
	pushFlags: string[];
}

export interface ResolvedConfig extends Required<Omit<ShipConfig, "git">> {
	root: string;
	dryRun: boolean;
	anyBranch: boolean;
	tag: string;
	steps: Required<NonNullable<ShipConfig["steps"]>>;
	git: ResolvedGitConfig;
	github: Required<NonNullable<ShipConfig["github"]>>;
	npm: {
		cwd: string;
		access: "public" | "restricted";
		targets: NpmTarget[];
	};
	homebrew: Required<NonNullable<ShipConfig["homebrew"]>>;
}
