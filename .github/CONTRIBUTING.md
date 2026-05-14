# Contributing to shipx

Thanks for considering a contribution! shipx is small and friendly — most PRs land within a few days.

## Setup

```bash
git clone https://github.com/lacymorrow/shipx.git
cd shipx
bun install
```

Requires [Bun](https://bun.com) ≥ 1.0 and Node ≥ 18.

## Development loop

```bash
bun run dev          # run shipx against the current directory
bun run typecheck    # tsc --noEmit
bun run build        # bundle to dist/cli.js (Node-targeted)
```

There are no automated tests. The honest dev loop is:

1. Make your change.
2. `bun run typecheck`.
3. Spin up a throwaway project (`bash media/setup-demo.sh`) and run `SHIPX_ROOT=/tmp/shipx-demo bun run src/cli.ts` against it.
4. Verify the interactive flow looks right and the destructive steps you toggled actually run / don't run.

## Project layout

- `src/cli.ts` — entry point. Calls `loadConfig()` then runs steps in a fixed order.
- `src/config.ts` — config resolution and auto-detection.
- `src/types.ts` — public `ShipConfig` / `BumpFileConfig` surface.
- `src/steps/*.ts` — one function per pipeline step. Shell out via `exec()` from `src/utils.ts`.
- `src/utils.ts` — `exec()` / `shell()` / `readJson()` / `writeJson()` helpers.

See [`CLAUDE.md`](../CLAUDE.md) for a deeper architectural tour.

## Conventions

- **TypeScript with `.ts` import extensions** (e.g. `./utils.ts`). Build bundles everything; preserve the suffixes.
- **Tabs for indentation.** Match existing files.
- **No default exports.**
- **`exec()` over `shell()`** — use argv form (`exec("git", ["push", ...])`) instead of a shell string. Fall back to `shell()` only when you genuinely need a shell pipeline.
- **`p.log.*` and `picocolors` for user output** — not `console.log` — so the [@clack/prompts](https://github.com/bombshell-dev/clack) UI stays cohesive.

## Commit messages

[Conventional Commits](https://www.conventionalcommits.org/) — `feat:`, `fix:`, `docs:`, `chore:`, `refactor:`, `test:`.

The generated changelog uses these directly as bullet items, so write commit subjects you'd be okay seeing in a release.

## Releasing

shipx releases itself. From `main`, on a clean tree:

```bash
bun run dev          # interactive
bun run dev --beta   # pre-release
```

For CI-based publishing with [npm provenance](https://docs.npmjs.com/generating-provenance-statements), add `"provenance": true` to `publishConfig` and move `npm publish` into a GitHub Actions workflow with OIDC.

## Recording the demo

`media/demo.tape` records the README's demo GIF via [VHS](https://github.com/charmbracelet/vhs):

```bash
brew install vhs     # or: go install github.com/charmbracelet/vhs@latest
vhs media/demo.tape  # writes .github/assets/demo.gif
```

## Code of conduct

Be kind. Don't be a jerk. Lacy's house, Lacy's rules. Egregious behavior gets you removed.
