# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed (LAC-2021)

- **npm registry lookup distinguishes 404 vs network error** (`registry.ts`). Previously, both produced a silent `null` and shipx would bump from a stale local version even if the registry was unreachable; now network failures surface a loud warning that the publish may collide.
- **Tag collision guard before commit** (`git.ts`, `preflight.ts`). `commitAndTag` now refuses to run when the target tag already exists locally and throws before the release commit is created, so a stale tag from a half-finished run no longer corrupts the next release.
- **Rebase-conflict guidance** (`git.ts`). When `git pull --rebase` fails during the push-and-retry path, the warning now lists the local-only release tags created by this run and shows the exact `git tag -d …` command to clean them up before retrying.
- **Cargo bump failure no longer hard-exits** (`steps/cargo.ts`). The step now throws so the CLI's outer error handler (and any future rollback logic) can react, instead of `process.exit(1)` killing the pipeline mid-flight.
- **Conventional-Commit breaking-change detection is anchored** (`steps/changelog.ts`). The previous `subject.includes("!:")` fired on subjects like `fix: handle !:= operator`; now matches the `<type>(<scope>)?!:` prefix only.
- **GitHub release returns success/failure** (`steps/github.ts`). For beta releases this is the only prerelease signal, so the result is no longer swallowed — callers get a `false` and a manual `gh release create` hint on failure.
- **Quoted commit/push flags preserved** (`types.ts`, `config.ts`, `steps/git.ts`). `git.commitFlags` / `git.pushFlags` now accept `string[]` (preferred) in addition to the legacy whitespace-split string, so arguments containing spaces don't get torn apart.
- **Shell-free cleanup/test invocations** (`steps/cleanup.ts`, `steps/test.ts`). Replaced the `shell()` wrappers with `exec()` per the repo convention, removing the shell-quoting surface area for install/test commands.
- **`--tag <dist-tag>` honored in `--multi`** (`cli.ts`, `multi.ts`). The flag was previously silently dropped when running multi-project deploys.
- **Preflight `npm whoami` targets the right registry** (`steps/preflight.ts`). Scoped packages (`@scope/name`) and packages with `publishConfig.registry` are now checked against the registry the publish will actually use, fixing misleading "not logged in" warnings on private registries.
- **Homebrew tarball download** (`steps/homebrew.ts`). Added `curl -f` so a 404 doesn't get hashed and committed as the formula's SHA256, and the tmp file is now unlinked in all paths.
- **Silent no-op in `bumpFiles`** (`steps/bump.ts`). When a `bumpFiles` regex doesn't match, the file is no longer rewritten unchanged (and unnecessarily staged) — instead the user gets a clear warning.
- **Build postprocess sanity check** (`scripts/postbuild.mjs`, `package.json`). The bun→node shebang rewrite now lives in a dedicated script and throws if `dist/cli.js` doesn't start with the expected node shebang, so a future bun output format change fails the build instead of silently shipping a broken binary.

### Added

- **npm registry version check**: before prompting for a bump, shipx now queries `npm view <pkg> version` and — if the registry is ahead of the local `package.json` — warns the user and offers to use the registry version as the bump base. Prevents the `Cannot implicitly apply the "latest" tag because previously published version X.Y.Z is higher than the new version` publish failure when local state has drifted behind the registry. Applies to both single mode and `--multi`; skipped for private packages and when the npm step is disabled. [LAC-1951]

### Fixed

- **`.shipxignore` no longer clobbered by `--multi`**: previously, every multi-project run rewrote `.shipxignore` to include every project not currently selected, silently adding the entire repo dir tree on the first default-accept. Now only the explicit user delta is persisted (pre-selected projects that were deselected are added; previously-ignored projects that were selected are removed), and the file is only rewritten when the set actually changes. [LAC-2017]
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
