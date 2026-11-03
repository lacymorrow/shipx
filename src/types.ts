export interface BumpFileConfig {
	path: string;
	pattern: RegExp;
	replacement: (version: string) => string;
}

export interface HookContext {
	config: ResolvedConfig;
	/** Empty string before version selection (preBump and later have the value) */
	version: string;
	/** Empty string before version selection (preBump and later have the value) */
	tag: string;
	/** Placeholder until changelog generation (postChangelog and later have the final value) */
	changelog: string;
	isBeta: boolean;
}

export type HookFunction = (context: HookContext) => void | Promise<void>;

export interface Hooks {
	prePreflight?: HookFunction;
	postPreflight?: HookFunction;
	preCleanup?: HookFunction;
	postCleanup?: HookFunction;
	preTest?: HookFunction;
	postTest?: HookFunction;
	preBump?: HookFunction;
	postBump?: HookFunction;
	preChangelog?: HookFunction;
	postChangelog?: HookFunction;
	preCommit?: HookFunction;
	postCommit?: HookFunction;
	prePush?: HookFunction;
	postPush?: HookFunction;
	preGithubRelease?: HookFunction;
	postGithubRelease?: HookFunction;
	preNpm?: HookFunction;
	postNpm?: HookFunction;
	preHomebrew?: HookFunction;
	postHomebrew?: HookFunction;
	preXcode?: HookFunction;
	postXcode?: HookFunction;
}

export type XcodePlatform = "ios" | "macos" | "tvos" | "visionos";

export interface AscKeyConfig {
	/** App Store Connect API key ID. Default: env `ASC_KEY_ID`, then `~/.appstoreconnect/env` */
	keyId?: string;
	/** App Store Connect issuer ID. Default: env `ASC_ISSUER_ID`, then `~/.appstoreconnect/env` */
	issuerId?: string;
	/** Path to the .p8 key. Default: `~/.appstoreconnect/private_keys/AuthKey_<keyId>.p8` */
	keyPath?: string;
}

export interface XcodeConfig {
	/**
	 * File holding `MARKETING_VERSION`, relative to the project root. A XcodeGen
	 * `project.yml` or a `.xcconfig`. Default: `project.yml` when it exists.
	 */
	versionFile?: string;
	/**
	 * Where the build number (CURRENT_PROJECT_VERSION) comes from.
	 * - `"commitCount"` (default): `git rev-list --count HEAD` plus `buildNumberOffset`,
	 *   counted after the release commit.
	 * - `"increment"`: the stored CURRENT_PROJECT_VERSION in `versionFile` plus one,
	 *   written back and staged in the release commit.
	 */
	buildNumber?: "commitCount" | "increment";
	/** Added to the commit count. Use it to stay above build numbers already uploaded. Default: 0 */
	buildNumberOffset?: number;
	/** Run `xcodegen generate` before archiving when `project.yml` exists. Default: true */
	generate?: boolean;
	/** Xcode scheme to archive. Default: XcodeGen `name:` or the `.xcodeproj` name */
	scheme?: string;
	/**
	 * Platforms to archive, each mapped to `generic/platform=<Platform>`.
	 * The Apple Watch app ships inside the iOS archive, so there is no watchOS entry.
	 * Default: `["ios"]`
	 */
	platforms?: XcodePlatform[];
	/** Custom export options plist, relative to the project root. Default: a generated `app-store-connect` plist */
	exportOptionsPlist?: string;
	/** App Store Connect API key used for provisioning updates and the upload */
	ascKey?: AscKeyConfig;
	/** Upload to App Store Connect after exporting. `--no-upload` overrides it. Default: true */
	upload?: boolean;
}

export interface ResolvedXcodeConfig {
	/** True for an Xcode project (auto-detected, or `xcode` is set in the config) */
	enabled: boolean;
	versionFile: string;
	buildNumber: "commitCount" | "increment";
	buildNumberOffset: number;
	generate: boolean;
	scheme: string;
	platforms: XcodePlatform[];
	exportOptionsPlist: string;
	/** Null when no key id and issuer id could be found */
	ascKey: { keyId: string; issuerId: string; keyPath: string } | null;
	upload: boolean;
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
	 * Keep a Changelog file to record each release in, relative to the project root.
	 * Default: 'CHANGELOG.md'. Set to '' to leave the file alone.
	 *
	 * The file is only updated when it already exists; shipx never creates one.
	 * Content under `## [Unreleased]` is promoted into the new release section;
	 * when that section is empty, the release is written from the commits instead.
	 */
	changelogFile?: string;
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
		/**
		 * Archive, export and upload an Xcode project to App Store Connect.
		 * Runs after the push and before the GitHub release; does nothing
		 * unless the project is an Xcode project. Default: true
		 */
		xcode?: boolean;
		/**
		 * After the push, watch the CI runs the pushed tag(s) triggered and
		 * report what they did. Only active when at least one step is delegated
		 * to CI (`githubRelease: false` or `homebrew: false`) and `gh` is on
		 * PATH. shipx exits non-zero when a watched run fails, and warns when a
		 * pushed tag triggers no run at all (a misconfigured workflow trigger).
		 * Default: true. Disable with `--no-watch-ci` or when running shipx
		 * inside CI itself.
		 */
		watchCi?: boolean;
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
	/**
	 * Apple app (Xcode) release settings. A repo with `project.yml` or a
	 * `*.xcodeproj` and no `package.json` is treated as an Xcode project even
	 * when this is omitted. Then the version lives in MARKETING_VERSION, and the
	 * npm and Homebrew steps skip themselves.
	 */
	xcode?: XcodeConfig;
	/** Lifecycle hooks that run before/after each pipeline step */
	hooks?: Hooks;
}

export interface ResolvedGitConfig {
	releaseBranch: string;
	tagPrefix: string;
	extraTags: string[];
	commitMessage: string;
	commitFlags: string[];
	pushFlags: string[];
}

export interface ResolvedConfig extends Required<Omit<ShipConfig, "git" | "hooks" | "xcode">> {
	root: string;
	/**
	 * Filename this config was actually loaded from, e.g. `shipx.config.mts`,
	 * `.shipxrc.json`, or `package.json` for the `"shipx"` key. Empty string
	 * when no config exists and bare defaults are in use. Messages that tell
	 * the user to set an option name the file via `configFileLabel()` rather
	 * than saying "your shipx config", which leaves them guessing (LAC-2069).
	 */
	configFile: string;
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
		/**
		 * Human-readable reason describing how `cwd` was chosen by auto-detection.
		 * Empty string when the user explicitly configured `npm.cwd` / `npm.targets`,
		 * or when no auto-detection fired.
		 */
		autoDetectedReason: string;
	};
	homebrew: Required<NonNullable<ShipConfig["homebrew"]>>;
	xcode: ResolvedXcodeConfig;
	hooks: Hooks;
}
