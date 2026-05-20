<div align="center">
  <a href="https://github.com/lacymorrow/shipx">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/lacymorrow/shipx/main/.github/assets/logo-horizontal-dark.svg">
      <img src="https://raw.githubusercontent.com/lacymorrow/shipx/main/.github/assets/logo-horizontal.svg" alt="shipx" width="320">
    </picture>
  </a>

  <p><strong>Interactive release CLI</strong> ➔ bump, tag, publish, and ship — npm · Cargo · Homebrew · GitHub.</p>

  <p>
    <a href="https://www.npmjs.com/package/@lacymorrow/shipx"><img alt="npm version" src="https://img.shields.io/npm/v/@lacymorrow/shipx?style=flat"></a>
    <a href="https://www.npmjs.com/package/@lacymorrow/shipx"><img alt="npm downloads" src="https://img.shields.io/npm/dm/@lacymorrow/shipx?style=flat"></a>
    <a href="https://github.com/lacymorrow/shipx/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/lacymorrow/shipx/ci.yml?style=flat&label=CI"></a>
    <a href="./LICENSE"><img alt="License" src="https://img.shields.io/npm/l/@lacymorrow/shipx?style=flat"></a>
    <a href="https://nodejs.org"><img alt="Node" src="https://img.shields.io/node/v/@lacymorrow/shipx?style=flat"></a>
  </p>

  <img src="https://raw.githubusercontent.com/lacymorrow/shipx/main/.github/assets/demo.gif" alt="shipx running an interactive release in the terminal" width="900">
</div>

---

> [!NOTE]
> shipx is a thin, opinionated wrapper around `npm publish`, `git tag`, `gh release`, `cargo set-version`, and a Homebrew formula update. It's a beautiful pipeline for the release ritual you already know — not a magic black box.

## Why shipx

Releasing a package is the same nine commands every time, in the same order, and you don't want to forget any of them or run them out of order.

- **Beautiful interactive UI** built on [@clack/prompts](https://github.com/bombshell-dev/clack) — spinners, prompts, and confirms that you actually enjoy looking at.
- **One config, every channel.** npm, GitHub releases, Cargo workspaces (Tauri-friendly), and Homebrew tap formula — all from a single `shipx.config.ts`.
- **Stop on red.** Preflight refuses to run on a dirty tree or the wrong branch. Each step is a single shell-out — no hidden state, no surprises.
- **Beta path.** `shipx --beta` increments `-beta.N` and publishes with the `beta` dist-tag. Homebrew is skipped automatically.
- **Recoverable.** If `npm publish` fails (auth, OTP, network), shipx drops into an interactive retry loop instead of aborting the whole pipeline.
- **Zero install.** `npx @lacymorrow/shipx` runs against the project in your current directory.

## Install

```bash
# Global
npm install -g @lacymorrow/shipx
shipx

# One-off
npx @lacymorrow/shipx

# In your repo
npm install --save-dev @lacymorrow/shipx
```

Requires Node ≥20. `gh` CLI is required for `githubRelease`. `cargo-edit` is required if you bump Cargo workspaces.

## Usage

```bash
# Interactive — prompts for patch / minor / major
shipx

# Skip the prompt
shipx patch
shipx minor
shipx major

# Explicit version
shipx 2.0.0

# Beta release (publishes with --tag beta, skips Homebrew)
shipx --beta

# Multi-project deploy — scan parent dir, batch-publish with one OTP
cd ~/repo && shipx --multi
```

> [!TIP]
> Set `SHIPX_ROOT=/path/to/project` to run shipx against a project other than the current directory — useful in monorepo automation.

## Pipeline

```mermaid
flowchart LR
    A[preflight] --> B[bump version]
    B --> C[changelog]
    C --> D[commit + tag]
    D --> E[push]
    E --> F[GitHub release]
    F --> G[npm publish]
    G --> H[Homebrew]

    style A fill:#c026d3,stroke:#c026d3,color:#fff
    style H fill:#c026d3,stroke:#c026d3,color:#fff
```

Each step is independently toggleable. Set `steps.<name>: false` to skip it.

## Configuration

shipx looks for config in this order, first hit wins:

1. `shipx.config.ts` / `shipx.config.js`
2. `.shipxrc.json` / `.shipxrc`
3. `"shipx"` key in `package.json`
4. Defaults (auto-detects `package.json`, `src-tauri/Cargo.toml`, and sibling `../homebrew-tap`)

### Example `shipx.config.ts`

```ts
import type { ShipConfig } from "@lacymorrow/shipx";

export default {
  packageJsonPaths: ["package.json", "packages/core/package.json"],
  bumpFiles: [
    {
      path: "bin/cli",
      pattern: /^VERSION="[^"]*"/m,
      replacement: (v) => `VERSION="${v}"`,
    },
  ],
  cargoWorkspaces: ["src-tauri"],
  steps: {
    homebrew: true,
    githubRelease: true,
  },
  git: {
    releaseBranch: "main",
    tagPrefix: "v",
    extraTags: ["cua-{tag}"],
    commitMessage: "release: {tag}",
  },
  npm: {
    access: "public",
  },
  homebrew: {
    tapPath: "../homebrew-tap",
    formulaFile: "Formula/mytool.rb",
    repoSlug: "user/repo",
  },
} satisfies ShipConfig;
```

### All options

| Option | Type | Default | What it does |
|---|---|---|---|
| `packageJsonPaths` | `string[]` | Auto (`["package.json"]`) | Paths to `package.json` files to bump |
| `bumpFiles` | `BumpFileConfig[]` | `[]` | Additional files with regex-based version bumping |
| `cargoWorkspaces` | `string[]` | Auto (`["src-tauri"]` if exists) | Cargo workspace dirs to bump via `cargo set-version --workspace`. Use `[]` to opt out. |
| `steps.preflight` | `boolean` | `true` | Require clean tree + correct branch |
| `steps.bumpVersion` | `boolean` | `true` | Update version in `package.json` + bump files |
| `steps.changelog` | `boolean` | `true` | Generate changelog from `git log` since last tag |
| `steps.commit` | `boolean` | `true` | Single commit for all bumped files |
| `steps.tag` | `boolean` | `true` | Create git tag (plus any `extraTags`) |
| `steps.push` | `boolean` | `true` | Push commit + tag(s) to `origin` |
| `steps.githubRelease` | `boolean` | `true` | Create GitHub release via `gh` CLI |
| `steps.npm` | `boolean` | `true` | Publish to npm (with interactive retry) |
| `steps.homebrew` | `boolean` | `true` | Update Homebrew formula SHA + URL |
| `git.releaseBranch` | `string` | `"main"` | Branch required for stable releases |
| `git.tagPrefix` | `string` | `"v"` | Prefix prepended to the version |
| `git.extraTags` | `string[]` | `[]` | Additional tags. Templates support `{tag}` (full, e.g. `v0.5.3`) and `{version}` (bare) |
| `git.commitMessage` | `string` | `"release: {tag}"` | Commit message template |
| `git.commitFlags` | `string` | `"--no-verify"` | Flags passed to `git commit` |
| `git.pushFlags` | `string` | `"--no-verify"` | Flags passed to `git push` |
| `npm.cwd` | `string` | Project root | Working directory for `npm publish` |
| `npm.access` | `"public" \| "restricted"` | `"public"` | npm publish access |
| `homebrew.tapPath` | `string` | Auto (sibling `../homebrew-tap`) | Path to your tap repo |
| `homebrew.formulaFile` | `string` | Auto-derived | Formula file, relative to `tapPath` |
| `homebrew.repoSlug` | `string` | Auto-derived from `origin` | `owner/repo` for the tarball URL |
| `homebrew.commitMessage` | `string` | `"{formula}: update to {tag}"` | Tap commit message template |

## Recipes

### Tauri / Cargo workspace

shipx auto-detects `src-tauri/Cargo.toml` and adds it to `cargoWorkspaces`. Requires `cargo install cargo-edit`.

```ts
// shipx.config.ts
export default {
  cargoWorkspaces: ["src-tauri"], // explicit; or omit for auto-detection
  steps: { npm: false }, // Tauri apps usually don't publish to npm
} satisfies ShipConfig;
```

### Monorepo with coupled versioning

All packages bump to the same version:

```ts
export default {
  packageJsonPaths: [
    "package.json",
    "packages/core/package.json",
    "packages/cli/package.json",
  ],
} satisfies ShipConfig;
```

For *independently*-versioned monorepos, use [changesets](https://github.com/changesets/changesets) instead — shipx isn't built for that.

### Homebrew tap

Drop your tap repo next to your project as a sibling (`../homebrew-tap`) and shipx finds it. Or configure it explicitly:

```ts
export default {
  homebrew: {
    tapPath: "../homebrew-tap",
    formulaFile: "Formula/mytool.rb",
    repoSlug: "lacymorrow/mytool",
  },
} satisfies ShipConfig;
```

shipx downloads the tarball, computes SHA256, updates `url`/`sha256` in the formula, commits, and pushes from the tap.

### Multi-project deploy

Got a bunch of repos in `~/repo/`? Deploy them all at once:

```bash
cd ~/repo
shipx --multi
```

shipx scans for subdirectories with a `package.json`, detects which have unreleased commits, and lets you pick which to release. The killer feature: **npm publishes are batched** — enter your OTP once and it's reused across all packages, so your 2FA code doesn't expire mid-deploy.

The flow:
1. **Select projects** — sorted by change count, with dirty/private indicators
2. **Pick versions** — individually, or apply the same bump type to all
3. **Prepare** — each project gets its own bump → commit → tag → push → GitHub release
4. **Batch publish** — all npm publishes happen back-to-back with a shared OTP
5. **Homebrew** — formulas updated for non-beta releases

Combine with `--beta` for beta batch releases: `shipx --multi --beta`.

### Beta release

```bash
shipx --beta
```

- If current version is `1.0.0`, becomes `1.0.0-beta.0`
- If current version is `1.0.0-beta.0`, becomes `1.0.0-beta.1`
- Publishes to npm with `--tag beta` (your `latest` dist-tag is untouched)
- Skips the branch check in preflight (release from any branch)
- Skips Homebrew automatically

## Comparison

| | shipx | [np](https://github.com/sindresorhus/np) | [release-it](https://github.com/release-it/release-it) | [changesets](https://github.com/changesets/changesets) |
|---|:-:|:-:|:-:|:-:|
| Interactive UI | ✅ ([@clack](https://github.com/bombshell-dev/clack)) | ✅ (Listr) | partial | ❌ |
| npm publish | ✅ | ✅ | ✅ | ✅ |
| GitHub release | ✅ | ✅ | ✅ | via Action |
| **Cargo workspaces** | ✅ | ❌ | via plugin | ❌ |
| **Homebrew formula** | ✅ | ❌ | via plugin | ❌ |
| Beta / pre-release | ✅ | ✅ | ✅ | ✅ |
| **Multi-project batch deploy** | ✅ | ❌ | ❌ | ❌ |
| Multi-package monorepo (coupled) | ✅ | ❌ | ✅ | ✅ |
| Multi-package monorepo (independent) | ❌ | ❌ | ✅ | ✅ |
| Changelog from PR labels | ❌ | ❌ | via plugin | ✅ |
| Zero plugins required | ✅ | ✅ | ❌ | ✅ |

**TL;DR** — Use **shipx** for single-package or coupled-version projects that ship to *multiple* registries (especially Cargo + Homebrew). Use **changesets** for independently-versioned monorepos. Use **np** if you want a smaller, npm-only tool.

## FAQ

<details>
<summary><strong>How is shipx different from <code>np</code>?</strong></summary>

[np](https://github.com/sindresorhus/np) is excellent and the spiritual predecessor of shipx. The differences:

- shipx uses [@clack/prompts](https://github.com/bombshell-dev/clack) instead of Listr — the UI feels more modern.
- shipx bumps **Cargo workspaces** and updates **Homebrew formulas** out of the box. np is npm-only.
- shipx is intentionally tiny (~600 lines of TS, two runtime deps). np is more battle-tested with more options.
</details>

<details>
<summary><strong>What if <code>npm publish</code> fails?</strong></summary>

shipx drops into an interactive retry loop with four options:

1. **Enter OTP** — for 2FA accounts (validates that you typed 6 digits)
2. **Log in to npm** — runs `npm login`, then retries
3. **Retry** — just try again (good for transient errors)
4. **Skip** — abandon `npm publish` and continue to remaining steps

Everything before `npm publish` (the bump, commit, tag, push, GitHub release) is already done — you can always re-publish manually.
</details>

<details>
<summary><strong>Can I disable a step?</strong></summary>

Yes. Every step in the pipeline has a `steps.<name>` boolean flag. Set it to `false` to skip:

```ts
export default {
  steps: { homebrew: false, githubRelease: false },
} satisfies ShipConfig;
```
</details>

<details>
<summary><strong>Does shipx sign tags or commits?</strong></summary>

shipx delegates to your local `git` config. Set `commit.gpgsign=true` / `tag.gpgsign=true` and your tags will be signed. The default `commitFlags` / `pushFlags` of `--no-verify` is overrideable via config if you have hooks you actually want to run.
</details>

<details>
<summary><strong>Can I extract the changelog before shipping?</strong></summary>

shipx generates a changelog from `git log <last-tag>..HEAD --pretty=format:"- %s (%h)"` and uses it as the GitHub release body. It's printed to the terminal during the release. If you need a `CHANGELOG.md` file, write your own bumpFile entry — or use [git-cliff](https://github.com/orhun/git-cliff) before invoking shipx.
</details>

## Related

Other projects by the author:

- [album-art](https://github.com/lacymorrow/album-art) — Fetch an album or artist image URL.
- [crossover](https://github.com/lacymorrow/crossover) — A crosshair overlay for any screen.
- [cinematic](https://github.com/lacymorrow/cinematic) — Gorgeous desktop movie collections.

## Acknowledgments

shipx stands on the shoulders of:

- [@clack/prompts](https://github.com/bombshell-dev/clack) by [Nate Moore](https://github.com/natemoo-re) — the prompt UI that makes shipx feel delightful.
- [np](https://github.com/sindresorhus/np) by [Sindre Sorhus](https://github.com/sindresorhus) — the original prior art for a "better `npm publish`".
- [picocolors](https://github.com/alexeyraspopov/picocolors) by [Alexey Raspopov](https://github.com/alexeyraspopov) — fast, tiny ANSI colors.
- [Bun](https://bun.com) — the bundler that ships shipx itself.
- [Charmbracelet VHS](https://github.com/charmbracelet/vhs) — used to record the demo above.

## Contributing

Bug reports and pull requests welcome. See [CONTRIBUTING.md](.github/CONTRIBUTING.md) and the [security policy](.github/SECURITY.md). For a high-level architecture overview, see [CLAUDE.md](./CLAUDE.md).

## License

[MIT](./LICENSE) © [Lacy Morrow](https://lacymorrow.com)

<div align="center">
  <sub>If shipx saved you time, consider <a href="https://github.com/sponsors/lacymorrow">sponsoring on GitHub</a>, <a href="https://patreon.com/lacymorrow">supporting on Patreon</a>, or <a href="https://buymeacoffee.com/lm">buying a coffee</a>.</sub>
</div>
