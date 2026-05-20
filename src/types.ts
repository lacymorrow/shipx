export interface BumpFileConfig {
	path: string;
	pattern: RegExp;
	replacement: (version: string) => string;
}

export interface ShipConfig {
	/** Paths to package.json files to version-bump (relative to project root) */
	packageJsonPaths?: string[];
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
		changelog?: boolean;
		bumpVersion?: boolean;
		commit?: boolean;
		tag?: boolean;
		push?: boolean;
		githubRelease?: boolean;
		npm?: boolean;
		homebrew?: boolean;
	};
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
		/** Commit flags. Default: '--no-verify' */
		commitFlags?: string;
		/** Push flags. Default: '--no-verify' */
		pushFlags?: string;
	};
	/** npm publish settings */
	npm?: {
		/** Working directory for npm publish. Default: project root */
		cwd?: string;
		/** npm publish access. Default: 'public' */
		access?: "public" | "restricted";
	};
	/** GitHub release settings */
	github?: {
		/** Create the release as a draft so you can review before publishing. Default: false */
		draft?: boolean;
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
	};
}

export interface ResolvedConfig extends Required<ShipConfig> {
	root: string;
	steps: Required<NonNullable<ShipConfig["steps"]>>;
	git: Required<NonNullable<ShipConfig["git"]>>;
	github: Required<NonNullable<ShipConfig["github"]>>;
	npm: Required<NonNullable<ShipConfig["npm"]>>;
	homebrew: Required<NonNullable<ShipConfig["homebrew"]>>;
}
