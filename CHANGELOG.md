# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Versions missing from this file shipped only a version bump or a dependency update.

## [Unreleased]

### Added

- **Releases record themselves in your changelog** (`changelog-file.ts`). When a project has a `CHANGELOG.md`, shipx now writes the release into it and stages it with the release commit. Whatever sits under `## [Unreleased]` is promoted into a new `## [x.y.z] - date` section and `Unreleased` is emptied; when that section is empty, the release is written from the commits instead, mapping `feat` to Added, `fix` to Fixed, and `perf`/`refactor`/`revert` to Changed, with breaking changes leading their category. Housekeeping commits stay out. Link reference definitions are updated when the file already uses them. shipx never creates a changelog, only updates one that exists, and re-running after a failed release will not duplicate a section. Set `changelogFile: ""` to turn it off.
- **CI runs the tests** (`.github/workflows/ci.yml`). The `test` job typechecked, built, and smoke-tested the binary, but never ran a test.

### Fixed

- **Every test file runs, and they no longer interfere** (`scripts/test.mjs`). `bun test src/tests/` reached 7 of the 20 test files; the other 13 were never run by `bun run test`. Running them together surfaced why: `mock.module()` is global to the bun process, so the mocks in `steps/homebrew.test.ts` replaced `exec` for every file alongside it and `steps/git.test.ts` saw a stubbed git that reported tags which do not exist. Each file now runs in its own process. 20 of 20 files pass, 185 tests.

## [0.1.22] - 2026-09-14

### Added

- **`shipx.config.mts` and `shipx.config.mjs` both load** (`config.ts`). The lookup order is `.mts`, `.ts`, `.mjs`, `.js`. Reach for `.mts` first: it is ESM no matter what the project's `package.json` `type` says, so it works the same in every repo.

### Fixed

- **Loading a config no longer prints a Node module-type warning** (`config.ts`). Running shipx under Node in a project without `"type": "module"` printed `MODULE_TYPELESS_PACKAGE_JSON` for `shipx.config.ts`. That one warning is now suppressed while the config imports, so ESM and CommonJS projects both load quietly.

## [0.1.21] - 2026-09-14

### Fixed

- **Spinners animate while commands run** (`utils.ts`, all `steps/`). Every step shelled out with a synchronous exec, which blocked the event loop, so the clack spinner froze on one frame and long steps looked hung: npm publish, git push, GitHub release, Homebrew download and push, tests, clean install. Steps now await an async `run()` helper and the spinner keeps ticking. The post-publish registry check traded its blocking `Atomics.wait` sleep for an async one and shows its own spinner. Interactive commands that need the terminal, like `npm login` and web-auth publish, still use the sync `exec()`.

## [0.1.16] - 2026-05-25

### Fixed

- **Post-publish verification waits for the registry instead of crying wolf** (`npm.ts`). The verify step fired immediately after `npm publish` and warned whenever the registry CDN had not yet surfaced the new version, which was a false alarm essentially every time. `npm view` now retries up to five times with backoff, roughly 37 seconds total, and warns only if every attempt fails.

## [0.1.15] - 2026-05-25

### Fixed

- **shipx publishes the package you meant, not the monorepo root** (`detect.ts`, `config.ts`). Single-project mode had been publishing a workspace root `package.json` with no `bin` field, which broke `npx` for several versions in a row [LAC-2055]. `npm.cwd` is now the source of truth for what gets published, and shipx detects the real target when you have not set `npm.cwd` or `npm.targets`. Detection stays conservative: it picks a subpackage only when the root is clearly unpublishable, and it reports ambiguity rather than guessing between two candidates. A structurally unpublishable package now fails loudly instead of producing a tag and a GitHub release with no npm publish behind them [LAC-2090].

## [0.1.13] - 2026-05-24

### Added

- **Homebrew formulas can ship pre-built binaries** (`homebrew.binaryAssets`). Name your per-platform release assets and shipx downloads each one, computes its SHA256, and writes the `on_macos` / `on_linux` and `Hardware::CPU` conditional blocks into the formula. Source-tarball mode stays the default when `binaryAssets` is unset. [LAC-2027]
- **A release can upload its own GitHub assets** (`github.assets`). Give it glob patterns like `["dist/*.zip", "dist/*.tar.gz"]` and shipx resolves them against the project root after creating the release, then uploads the matches with `gh release upload --clobber`. With `--draft`, assets land before the browser opens, so you review a complete release. [LAC-2026]
- **Pre and post hooks run around every pipeline step** (`hooks` in config). Each hook receives a context with the config, version, tag, changelog, and beta flag. Dry-run logs hooks without running them, errors propagate, and hooks work in single and multi-project mode alike. [LAC-2028]
- **One release can publish several npm packages** (`npm.targets`). Useful for a wrapper package plus its platform binaries. The OTP is collected once and reused across all targets. [LAC-2025]
- **`versionSource` points at the package.json that owns the version.** In a monorepo where the root has no version field, set this to the sub-package that does, and single mode, multi mode, and preflight all read from it. Omit it and nothing changes. [LAC-2029]

### Fixed

- **Multi-mode skips monorepo workspace roots** (`discover.ts`, `multi.ts`). A `package.json` with a `workspaces` field almost never publishes cleanly, and releasing one produces a broken npm package. Workspace roots are now flagged as non-publishable and show as `(workspace)` in the selection list. An explicit `npm.cwd` or `npm.targets` in `shipx.config.ts` still overrides the flag, and the project name is re-read from the target package.json so the registry check looks up the right package. [LAC-2056]
- **Project discovery is parallel again** (`discover.ts`). Scanning a large parent directory had gone serial, so `--multi` startup dragged. [LAC-2038]

## [0.1.12] - 2026-05-22

### Added

- **`--dry-run` previews the whole pipeline without touching anything.** Every step reports what it would do, so you can check a config before a real release. [LAC-1938]
- **A failed npm publish offers to roll the release back.** The tag and the release commit are undone and you get a warning about what already reached the remote, instead of an orphaned tag sitting in the repo. [LAC-1938]
- **`--tag <name>` publishes to any dist-tag.** Beta is no longer the only alternative to `latest`; `next`, `canary`, and `rc` all work. A bare `--tag` with no value is an error. [LAC-1938]
- **`--any-branch` releases from a branch other than the release branch.** The clean-tree requirement still applies. [LAC-1938]
- **Preflight checks more before it lets you start.** It verifies npm auth, package entry points, whether the target tag already exists, whether the remote is in sync, and whether the `files` field or `.npmignore` will ship what you expect. [LAC-1938]
- **An opt-in test step runs before the release** (`steps.test`, `--no-tests`). The default script is `test`; override it with `testScript`. [LAC-1938]
- **An opt-in cleanup step reinstalls from a frozen lockfile** (`steps.cleanup`, `--no-cleanup`). It deletes `node_modules` and detects your package manager from the lockfile. [LAC-1938]
- **The npm registry version check catches drift before you bump.** shipx queries `npm view <pkg> version` and, when the registry is ahead of the local `package.json`, warns and offers the registry version as the bump base. This is what stops the `Cannot implicitly apply the "latest" tag because previously published version X.Y.Z is higher than the new version` failure. It runs in single mode and `--multi`, and skips private packages and disabled npm steps. [LAC-1951]
- **Archived GitHub repos are caught before any local change.** Preflight and multi-mode discovery check `gh repo view --json isArchived`. Single mode aborts with a clear error; `--multi` filters the repo out of the selection list with a warning. [LAC-1949]
- **npm passkey and web auth sit alongside OTP.** Web auth is listed first and marked recommended for multi-package deploys, since it sidesteps OTP reuse entirely. [LAC-1944]

### Fixed

- **`--multi` no longer clobbers `.shipxignore`** (`multi.ts`). Every multi-project run used to rewrite the file to include every project not currently selected, which quietly swallowed the entire repo tree on the first default-accept. Only your explicit delta is persisted now: projects you deselected get added, projects you selected get removed, and the file is written only when the set actually changes. [LAC-2017]
- **Pull-rebase survives a dirty tree** (`git.ts`). When a push rejection triggers `git pull --rebase` and the working tree still has unstaged changes, say because preflight warned and you continued anyway, shipx stashes the dirty files including untracked ones, pulls, then restores them. It used to fail with `cannot pull with rebase: You have unstaged changes`. [LAC-1950]
- **Batch npm publish collects a fresh OTP per package** (`multi.ts`). `--multi` prompted once and reused the code for every package, so every publish after the first got `EOTP`, because TOTP codes are single-use. Each package gets its own prompt now. [LAC-2018]
- **The npm registry lookup tells a 404 apart from a network error** (`registry.ts`). Both used to return a silent `null`, so shipx would bump from a stale local version even when the registry was unreachable. A network failure now raises a loud warning that the publish may collide. [LAC-2021]
- **A colliding tag stops the run before the commit** (`git.ts`, `preflight.ts`). `commitAndTag` refuses to run when the target tag already exists locally and throws before the release commit is created, so a stale tag from a half-finished run cannot corrupt the next release. [LAC-2021]
- **A failed rebase tells you exactly what to clean up** (`git.ts`). When `git pull --rebase` fails during push-and-retry, the warning lists the local-only release tags this run created and prints the `git tag -d ...` command to remove them. [LAC-2021]
- **A Cargo bump failure no longer hard-exits** (`steps/cargo.ts`). The step throws so the CLI's outer error handler, and any rollback logic added later, can react. It used to call `process.exit(1)` and kill the pipeline mid-flight. [LAC-2021]
- **Breaking-change detection is anchored to the commit prefix** (`steps/changelog.ts`). The old `subject.includes("!:")` check fired on a subject like `fix: handle !:= operator`. It now matches only the `<type>(<scope>)?!:` prefix. [LAC-2021]
- **The GitHub release step reports success or failure** (`steps/github.ts`). For a beta release this is the only prerelease signal, so the result is no longer swallowed. A failure returns `false` and prints the manual `gh release create` command. [LAC-2021]
- **Commit and push flags keep their quoting** (`types.ts`, `config.ts`, `steps/git.ts`). `git.commitFlags` and `git.pushFlags` accept a `string[]`, which is now the preferred form, alongside the legacy whitespace-split string. Arguments containing spaces no longer get torn apart. [LAC-2021]
- **Cleanup and test commands run without a shell** (`steps/cleanup.ts`, `steps/test.ts`). Both moved from `shell()` to `exec()` per the repo convention, which removes the shell-quoting surface from install and test commands. [LAC-2021]
- **`--tag <dist-tag>` is honored in `--multi`** (`cli.ts`, `multi.ts`). The flag was silently dropped on multi-project deploys. [LAC-2021]
- **Preflight runs `npm whoami` against the right registry** (`steps/preflight.ts`). Scoped packages and packages with a `publishConfig.registry` are checked against the registry the publish will actually use, which clears up misleading "not logged in" warnings on private registries. [LAC-2021]
- **A 404 tarball never becomes the formula's SHA256** (`steps/homebrew.ts`). The Homebrew download uses `curl -f`, and the temp file is unlinked on every path. [LAC-2021]
- **A non-matching `bumpFiles` regex warns instead of going quiet** (`steps/bump.ts`). The file used to be rewritten unchanged and staged for no reason. [LAC-2021]
- **The build fails loudly if the shebang rewrite breaks** (`scripts/postbuild.mjs`, `package.json`). The bun-to-node shebang rewrite lives in its own script and throws when `dist/cli.js` does not start with the expected node shebang, so a future bun output change fails the build rather than shipping a broken binary. [LAC-2021]
- **Rollback resets to the SHA it captured, not a blind `HEAD~1`** (`git.ts`). [LAC-2013]
- **Rollback tracks push state per tag** (`git.ts`). A tag that never reached the remote is handled differently from one that did. [LAC-2014]
- **A partial failure in multi-mode phase one rolls back** (`multi.ts`). Projects already prepared are unwound instead of left half-released. [LAC-2015]
- **A flag-shaped value is rejected instead of consumed** (`cli.ts`). `--tag --beta` no longer reads `--beta` as the dist-tag, and the `--no-tests` and `--no-cleanup` help text says what those flags actually do. [LAC-2016]
- **The Homebrew formula rewrite matches `url` and `sha256` as a pair** (`steps/homebrew.ts`) and verifies the replacement landed, so a formula layout it does not understand fails instead of committing a half-edit. [LAC-2019]
- **The Homebrew tap's branch is detected, and a dirty tap aborts** (`steps/homebrew.ts`). The step no longer assumes `main` and no longer commits on top of someone else's uncommitted work. [LAC-2020]
- **Multi-mode asks about Homebrew once, not per project** (`multi.ts`), and the prompt names the project it is talking about. [LAC-1943]

## [0.1.10] - 2026-05-20

### Fixed

- **The default branch is detected instead of assumed** (`git.ts`, `multi.ts`). Multi-mode could offer to switch to a branch that does not exist in that repo. [LAC-1934]

## [0.1.9] - 2026-05-20

### Added

- **shipx checks you are logged in before it tries to publish** (`steps/npm.ts`). It runs `npm whoami` up front and prompts you to log in, rather than failing later with a cryptic `E404`. Auth-shaped errors are flagged in the failure output. [LAC-1901]

### Fixed

- **A project with an unreadable `package.json` is skipped, not fatal** (`discover.ts`). The multi-deploy scan keeps going, and a `package.json` that parses to something other than an object no longer crashes discovery. [LAC-1904]
- **The npm recovery menu leads with OTP again** (`steps/npm.ts`). Reordering it for the login check had buried the option most people need. [LAC-1901]
- **README images render on npm** (`README.md`). Relative image paths broke on the package page; they are absolute now. [LAC-1896]

## [0.1.8] - 2026-05-20

### Added

- **The generated changelog groups commits by type.** Conventional-commit types get their own sections, with breaking changes at the top.
- **`--draft` and `github.draft` create a draft GitHub release** and open it in the browser, so you can read it before anyone else does.

### Fixed

- **The Homebrew tarball downloads to a temp file** (`steps/homebrew.ts`), which stops the `ENOBUFS` failure on larger release archives.
- **Node types are declared explicitly in `tsconfig.json`**, which TypeScript 6 requires.

## [0.1.7] - 2026-05-15

### Added

- **Multi-mode offers to switch branch or release from the current one** instead of refusing outright.
- **The post-push summary lists the tags that were pushed and the steps CI will handle.** With GitHub Release and Homebrew disabled, a finished release used to look like it had stopped halfway.

### Fixed

- **Ctrl-C exits cleanly during a spinner** (`cli.ts`). The cursor is restored and the process exits, so a `--multi` scan is no longer impossible to quit.

## [0.1.6] - 2026-05-15

### Added

- **A rejected push offers to `git pull --rebase` and retry.** When the remote is ahead, shipx no longer just aborts.

### Fixed

- **Spinners stop before an error is thrown** (all `steps/`), so a failure prints its message instead of hanging on a spinning frame.
- **The multi-project list is sorted by directory name.**

## [0.1.5] - 2026-05-15

### Fixed

- **The project scan is async, so its spinner animates** (`discover.ts`).
- **`package.json` resolution works on Windows** (`cli.ts`). `fileURLToPath` replaced the manual URL-to-path handling.

## [0.1.4] - 2026-05-15

### Added

- **`--help` and `--version`.**

## [0.1.3] - 2026-05-15

### Added

- **The multi-project scan shows progress**, and **`.shipxignore` keeps directories out of it.**

## [0.1.2] - 2026-05-15

### Fixed

- **The multi-project list uses directory names**, so two projects with the same `package.json` name are still tellable apart.

## [0.1.1] - 2026-05-15

### Added

- **`--multi` releases several projects in one run.** It scans a parent directory for projects, detects which have unreleased changes, lets you pick, and batches the npm publishes with a per-package OTP prompt or web auth so TOTP reuse does not sink the run.
- **Tauri projects get their Cargo version bumped.** `src-tauri/Cargo.toml` is auto-detected as a Cargo workspace, `cargoWorkspaces` sets the paths explicitly, and the bump runs through `cargo set-version --workspace`, which needs `cargo-edit` installed. Bumped Cargo directories are staged alongside the package.json files.
- **`git.extraTags` cuts additional tags from templates.** `{tag}` and `{version}` placeholders let a sub-product carry its own tag, for example `cua-{tag}`. Extra tags are deduplicated and never duplicate the main tag.
- **The intro banner shows the project being released**, read from the target `package.json` with any npm scope stripped, rather than a hardcoded "shipx".
- Logo, social preview banner, and `media/demo.tape` for reproducible terminal demos through [VHS](https://github.com/charmbracelet/vhs).
- Issue and pull request templates, FUNDING and dependabot config, SECURITY and CONTRIBUTING docs.
- CI workflow: typecheck and build on Node 18, 20, and 22.

### Changed

- README rewritten with badges, demo, pipeline diagram, comparison table, recipes, and FAQ.
- `package.json` author switched to object form, with `funding` added and `keywords` expanded.

### Fixed

- **Running outside a git repo fails with a readable message** instead of a raw git error.
- **`cargoWorkspaces: []` is a valid opt-out.** The auto-detection check is gated on `undefined` rather than on truthiness or length.
- **`bumpVersion: false` is respected.** The Cargo step used to run regardless.

## 0.1.0 - 2026-05-07

First release on npm.

### Added

- **The interactive release pipeline**, built on [@clack/prompts](https://github.com/bombshell-dev/clack): preflight, version bump, changelog, commit and tag, push, GitHub release, npm publish, Homebrew formula update.
- **Auto-detection for `package.json` and a sibling `../homebrew-tap`.**
- **`--beta` releases down a separate path.** It increments `-beta.N`, publishes with `--tag beta`, and skips Homebrew and the branch check.
- **A failed `npm publish` opens a retry loop**: enter an OTP, log in, retry, or skip.
- **Config resolution chain**: `shipx.config.ts`, then `.shipxrc.json`, then a `"shipx"` key in `package.json`, then defaults.
- **`SHIPX_ROOT`** runs shipx against a project outside the current directory.

### Fixed

- **The package publishes as `@lacymorrow/shipx`**, after the unscoped name turned out to be taken.
- **`package.json` is normalized before `npm publish`**, so scoped names work.

[Unreleased]: https://github.com/lacymorrow/shipx/compare/v0.1.22...HEAD
[0.1.22]: https://github.com/lacymorrow/shipx/compare/v0.1.21...v0.1.22
[0.1.21]: https://github.com/lacymorrow/shipx/compare/v0.1.20...v0.1.21
[0.1.16]: https://github.com/lacymorrow/shipx/compare/v0.1.15...v0.1.16
[0.1.15]: https://github.com/lacymorrow/shipx/compare/v0.1.14...v0.1.15
[0.1.13]: https://github.com/lacymorrow/shipx/compare/v0.1.12...v0.1.13
[0.1.12]: https://github.com/lacymorrow/shipx/compare/v0.1.11...v0.1.12
[0.1.10]: https://github.com/lacymorrow/shipx/compare/v0.1.9...v0.1.10
[0.1.9]: https://github.com/lacymorrow/shipx/compare/v0.1.8...v0.1.9
[0.1.8]: https://github.com/lacymorrow/shipx/compare/v0.1.7...v0.1.8
[0.1.7]: https://github.com/lacymorrow/shipx/compare/v0.1.6...v0.1.7
[0.1.6]: https://github.com/lacymorrow/shipx/compare/v0.1.5...v0.1.6
[0.1.5]: https://github.com/lacymorrow/shipx/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/lacymorrow/shipx/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/lacymorrow/shipx/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/lacymorrow/shipx/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/lacymorrow/shipx/releases/tag/v0.1.1
