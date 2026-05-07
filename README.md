# shipx

Interactive release CLI — bump, tag, publish, and ship your packages with a beautiful terminal UI.

Like [np](https://github.com/sindresorhus/np), but built with [@clack/prompts](https://github.com/bombshell-dev/clack) for a modern, delightful experience.

## Features

- Interactive version bumping (patch / minor / major / beta)
- Git preflight checks (clean tree, correct branch)
- Auto-generated changelog from git log
- Git commit, tag, and push
- GitHub release creation via `gh`
- npm publish with OTP retry flow
- Configurable steps per project

## Usage

```bash
npx shipx            # interactive — prompts for bump type
npx shipx patch      # patch bump
npx shipx minor      # minor bump
npx shipx major      # major bump
npx shipx --beta     # beta release
```

## Install

```bash
npm install -g shipx
# or
npm install --save-dev shipx
```

Then add to your `package.json`:

```json
{
  "scripts": {
    "release": "shipx",
    "release:beta": "shipx --beta"
  }
}
```

## License

MIT
