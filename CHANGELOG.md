# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **npm registry version check**: before prompting for a bump, shipx now queries `npm view <pkg> version` and — if the registry is ahead of the local `package.json` — warns the user and offers to use the registry version as the bump base. Prevents the `Cannot implicitly apply the "latest" tag because previously published version X.Y.Z is higher than the new version` publish failure when local state has drifted behind the registry. Applies to both single mode and `--multi`; skipped for private packages and when the npm step is disabled. [LAC-1951]

### Fixed

- **Pull-rebase with dirty trees**: when push rejection triggers `git pull --rebase` and the working tree still has unstaged changes (e.g. preflight warned but the user continued), shipx now stashes the dirty files (including untracked) before pulling and restores them afterward, instead of failing with `cannot pull with rebase: You have unstaged changes`. [LAC-1950]

### Added

- **Archived repo detection**: preflight (single mode) and discovery (multi mode) now check whether the GitHub remote is archived via `gh repo view --json isArchived`. Archived repos abort with a clear error before any local changes; in `--multi` they are filtered out of the selection list with a warning. [LAC-1949]
- **Pull-and-retry on push rejection**: when `git push` fails because the remote is ahead, shipx now offers to `git pull --rebase` and retry instead of aborting.
- **Multi-project deploy** (`--multi`): scan a parent directory for projects, detect unreleased changes, select which to release, batch npm publishes with a single OTP to avoid timeout issues.
- Logo, social preview banner, and `media/demo.tape` for reproducible terminal demos via [VHS](https://github.com/charmbracelet/vhs).
- Issue & pull request templates, FUNDING and dependabot config, SECURITY and CONTRIBUTING docs.
- CI workflow: typecheck and build on Node 18 / 20 / 22.

### Changed

- README rewritten with badges, demo, pipeline diagram, comparison table, recipes, and FAQ.
- `package.json` author switched to object form; added `funding`, expanded `keywords`.

## [0.1.0] — 2026-05-12

Initial public release.

### Added

- Interactive release pipeline built on [@clack/prompts](https://github.com/bombshell-dev/clack): preflight → bump version → changelog → commit + tag → push → GitHub release → npm publish → Homebrew formula update.
- Auto-detection for `package.json`, `src-tauri/Cargo.toml`, and sibling `../homebrew-tap`.
- Cargo workspace version bumping via `cargo set-version --workspace` (`cargoWorkspaces` config).
- Extra git tags via `git.extraTags` templates (`{tag}` and `{version}` placeholders) for sub-product release tags (e.g. `cua-{tag}`).
- Beta release path (`--beta`): increments `-beta.N`, publishes with `--tag beta`, skips Homebrew and the branch check.
- Interactive `npm publish` retry loop: OTP, login, retry, or skip.
- Config resolution chain: `shipx.config.ts` → `.shipxrc.json` → `"shipx"` key in `package.json` → defaults.
- `SHIPX_ROOT` environment variable to run shipx against a project outside the current directory.

### Fixed

- Cargo auto-detection gated on `undefined` rather than truthy/length so `cargoWorkspaces: []` is a valid opt-out.
- `bumpVersion: false` is now respected (Cargo step previously ran unconditionally).
- `package.json` is normalized before `npm publish` so scoped names work.

[Unreleased]: https://github.com/lacymorrow/shipx/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/lacymorrow/shipx/releases/tag/v0.1.0
