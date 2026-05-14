# Security Policy

## Reporting a vulnerability

If you've found a security issue in shipx — particularly anything involving:

- Command injection via `exec()` / `shell()` argument handling
- Path traversal through `bumpFiles[].path` or `homebrew.tapPath`
- Credential leakage (npm tokens, GitHub tokens, OTPs printed to logs)
- Anything that could compromise a release pipeline running with publish-level credentials

**Please don't open a public issue.** Report it privately via GitHub Security Advisories:

➔ https://github.com/lacymorrow/shipx/security/advisories/new

Or email **lacy@lacymorrow.com** with `[shipx security]` in the subject line.

You should expect an acknowledgement within 72 hours and a status update within 7 days. I'll credit reporters in the release notes for the fix unless you'd prefer to stay anonymous.

## Supported versions

Only the latest published version on npm receives security updates. shipx is small (~600 lines); there isn't capacity to maintain backports.

| Version | Supported |
|---------|:---------:|
| Latest  | ✅        |
| < latest | ❌       |

## Scope

In scope:
- The shipx CLI and its npm package
- The `media/setup-demo.sh` script
- The `media/demo.tape` recording flow (re-execution risk)

Out of scope:
- Issues in transitive dependencies — please report those upstream
- Issues that require an attacker who already has shell access on your machine (since at that point they can do anything shipx can do, and more)
