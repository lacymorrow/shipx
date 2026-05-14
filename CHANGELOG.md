# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

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
