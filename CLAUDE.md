# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`@lacymorrow/shipx` — an interactive release CLI built on `@clack/prompts`. Runs an ordered pipeline (preflight → cleanup → test → version bump → changelog → commit/tag → push → GitHub release → npm → Homebrew) over a project. Supports multi-project batch deploys via `--multi`. Published to npm; consumed by other repos in `~/repo/` (notably Juno via Cargo workspace support).

## Commands

| Task | Command |
|------|---------|
| Run locally against cwd | `bun run dev` (= `bun run src/cli.ts`) |
| Multi-project deploy | `bun run src/cli.ts --multi` (from parent dir, or `SHIPX_ROOT=~/repo`) |
| Run against another project | `SHIPX_ROOT=/path/to/project bun run src/cli.ts` |
| Typecheck | `bun run typecheck` (`tsc --noEmit`) |
| Build for publish | `bun run build` |
| Smoke-test built binary | `node dist/cli.js --help` |
| Dry-run preview | `bun run src/cli.ts --dry-run` |

There are no tests. Use `typecheck` + manual dev runs against a scratch repo.

### Build quirk

`bun build` emits a bun-flavored bundle. The build script rewrites the shebang `#!/usr/bin/env bun` → `#!/usr/bin/env node` and strips the `// @bun` marker so the published binary runs on plain Node. If you change bundler flags, preserve this rewrite — the package targets Node ≥18 and ships only `dist/`.

## Architecture

Single entry point `src/cli.ts` calls `loadConfig()` then invokes step modules in a fixed order. Steps are not pluggable — adding a step means editing both `cli.ts` and `types.ts` (`ShipConfig.steps`).

### Config resolution (`src/config.ts`)

Lookup order, first hit wins:
1. `shipx.config.ts` / `shipx.config.js` (dynamic `import()`)
2. `.shipxrc.json` / `.shipxrc`
3. `"shipx"` key in `package.json`
4. Bare defaults

After merging, several fields **auto-detect** when left undefined:
- `packageJsonPaths` defaults to `["package.json"]` if a root `package.json` exists.
- `cargoWorkspaces`: if **undefined** (not `[]`) and `src-tauri/Cargo.toml` exists, sets `["src-tauri"]`. The `undefined`-vs-`[]` distinction is load-bearing — `[]` is the explicit opt-out. Don't replace that check with a `.length` check.
- `homebrew.tapPath`: falls back to sibling `../homebrew-tap` if present.
- `homebrew.repoSlug` and `homebrew.formulaFile`: derived from `git remote get-url origin` when tap is set but slug/formula are not.
- `npm.cwd`: defaults to project root.

`ResolvedConfig` is `Required<ShipConfig>` plus `root` — all step modules receive a fully-populated config and should not re-defaulting.

### Step modules (`src/steps/`)

Each step is a function taking `ResolvedConfig`. They shell out via `exec()` / `shell()` in `utils.ts` (`execFileSync` / `execSync` with `encoding: "utf-8"`). Steps print progress via `@clack/prompts` spinners and `p.log.*`.

Notable behavior:
- **`preflight.ts`** — validates clean tree, correct branch, remote sync, archived repo, npm auth, package entry points, and package files field. `--any-branch` skips branch check. `--dry-run` skips all validation.
- **`cleanup.ts`** — opt-in (`steps.cleanup`). Deletes `node_modules` and reinstalls with frozen lockfile. Detects package manager from lockfile.
- **`test.ts`** — opt-in (`steps.test`). Runs the configured test script (default: `test`). Override with `testScript` config or disable with `--no-tests`.
- **`version.ts`** — prompts for patch/minor/major or accepts an explicit semver. Beta path (`--beta`) increments `-beta.N` if already a beta, otherwise creates `X.Y.Z-beta.0`. Pre-release suffix is stripped before computing the next stable.
- **`bump.ts`** — rewrites `package.json` `version` field and applies regex-based `bumpFiles` replacements. Returns paths to stage via `getFilesToStage()`.
- **`cargo.ts`** — shells `cargo set-version --workspace <v>` per workspace dir. Requires `cargo-edit` to be installed; failure prints the install hint and `process.exit(1)`.
- **`git.ts`** — single commit for all bumped files, then tag. `extraTags` templates support `{tag}` (full, e.g. `v0.5.3`) and `{version}` (bare). Dedup'd and never duplicates the main tag. Commit/push flags default to `--no-verify`; respect any user override rather than hardcoding bypasses.
- **`npm.ts`** — supports custom dist-tags via `--tag <name>` (e.g. next, canary, rc). On failure, opens an interactive retry loop with OTP/login/retry/skip. OTP must be 6 digits. Accepts an optional `otp` parameter for batch mode (multi-project deploy passes OTP through). If publish fails, cli.ts offers to **rollback** the release commit and tag.
- **`homebrew.ts`** — two modes. **Source mode** (default): downloads the GitHub tarball via `curl`, computes SHA256, regex-replaces `url` and `sha256` in the formula. **Binary mode** (when `homebrew.binaryAssets` is configured): downloads per-platform release assets, computes per-platform SHA256 hashes, and updates `on_macos`/`on_linux` + `Hardware::CPU` conditional blocks in the formula. Both modes commit and push from the tap repo. Skipped automatically for beta releases (`cli.ts` gates this). The binary formula updater lives in `homebrew-formula.ts` alongside the source formula updater.
- **`github.ts`** — uses `gh release create`. When `github.assets` glob patterns are configured, resolves them against the project root and uploads matched files via `gh release upload --clobber`. Upload failures are logged per-file but do not abort the pipeline. Failures are logged but do not abort the pipeline.

### Dry-run mode

`--dry-run` previews every step without executing. Each step checks `config.dryRun` and logs what it *would* do. Useful for verifying the pipeline configuration before a real release.

### Rollback on publish failure

If npm publish fails after the release commit/tag have been created, cli.ts prompts to rollback: deletes the tag(s) and resets the commit (`git reset --soft HEAD~1`). This prevents orphaned tags and commits.

### Multi-project mode (`src/multi.ts`, `src/discover.ts`)

`--multi` activates batch deploy mode. It scans the current (or `SHIPX_ROOT`) directory for subdirectories that contain a `package.json` and are git repos. For each it detects unreleased commits (since last tag), current version, and dirty state.

The flow runs in three phases:
1. **Prepare** — for each selected project: load its config, pick version, bump files, commit, tag, push, create GitHub release.
2. **npm publish** — batched: collects OTP once and passes it to all publishes back-to-back, solving the OTP-timeout problem.
3. **Homebrew** — updates formulas for non-beta releases.

`discoverProjects()` returns `DiscoveredProject[]` sorted by change count (most changes first). Projects with `private: true` in their `package.json` are flagged as non-npm-publishable.

### What "release branch" means

`preflight.ts` requires a clean tree and (for non-beta, non-`--any-branch`) refuses to run unless current branch equals `config.git.releaseBranch` (default `main`). Beta releases and `--any-branch` skip the branch check but still require a clean tree.

## Conventions specific to this repo

- TypeScript with `allowImportingTsExtensions: true` — imports use explicit `.ts` extensions (e.g. `./utils.ts`). Preserve this; the build bundles everything.
- Tabs for indentation (see existing files).
- No default exports. `cli.ts` re-exports `ShipConfig` / `BumpFileConfig` as the public type surface for downstream `shipx.config.ts` consumers.
- Use `exec()` from `utils.ts` (argv form, no shell) over `shell()` — only fall back to `shell()` when a true shell pipeline is needed.
- When adding user-visible output, prefer `p.log.*` and `picocolors` (`pc`) over `console.log` so it integrates with the clack UI.

## Where things live (non-code)

- `.github/assets/` — logo (SVG + PNG), horizontal lockup (light + dark), social-preview banner. SVGs are source of truth; PNGs are rasterized via `@resvg/resvg-js` for npm/social embeds. To regenerate: `node /tmp/shipx-rasterize.mjs` (or write a similar script — there's no committed rasterize script yet).
- `media/demo.tape` — VHS recording script. Re-record with `vhs media/demo.tape` (requires `brew install vhs`). Output lands at `.github/assets/demo.gif`.
- `media/setup-demo.sh` — sourced by the tape to spin up a throwaway `/tmp/shipx-demo` project that lets the demo run end-to-end without touching the network. Edit this if the demo flow needs to evolve.
- `CHANGELOG.md` — Keep-a-Changelog. Add to `[Unreleased]` as you go; shipx itself doesn't auto-update this file.
