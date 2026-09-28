# shipx demo: plan + script

Video 1 of the promo series. One story: a real release of shipx, shipped by shipx, from
the version prompt to the npm page refreshing. 60 to 75 seconds. Lacy narrates.

DRI: Lacy. Only Lacy can publish, and only Lacy's voice sells it.

## The one sentence

"Nine commands, every release, in the same order. I got tired of forgetting one."

## Why this cut

- The person: a JS/TS dev scrolling X or LinkedIn who has a `release.sh` they don't trust.
- The moment: 10 seconds to decide whether to keep watching.
- The proof: the npm page reloading with the new version. Nothing else convinces a dev.
- The current gif is a demo of a demo. Fake package, push/npm/homebrew turned off. It
  shows a prompt, not a release. It gets replaced by a cut of this video.

## What was removed (and why)

| Cut | Why |
|---|---|
| `--multi` batch deploy | The strongest feature, and the second video. Two stories in 60s is zero stories. |
| Config walkthrough | Nobody types config before they believe the tool. Defaults do the work on camera. |
| Beta, dry-run, hooks, Cargo | Later videos or README. |
| Logo intro, "hey everyone", face cam | Organic means starting mid-thought with the terminal already open. |
| Comparison to np / release-it | Say it in the post text, not the video. |
| Homebrew step | shipx has no formula, so the step prints a yellow "not found" warning on camera. Turn it off in config before recording. |

## Prep (do these before hitting record)

1. Land a real change so the changelog step has real lines. Suggested: add the config
   file below and tidy `CHANGELOG.md` (the Unreleased section still lists items that
   shipped in 0.1.22). Commit with a conventional message. That commit is the changelog.
2. Add `shipx.config.mts` to the repo. It is also the correct config for this repo.

   ```ts
   import type { ShipConfig } from "@lacymorrow/shipx";

   export default {
     steps: { homebrew: false },
   } satisfies ShipConfig;
   ```

3. Confirm `npm config get auth-type` prints `web`. It does today. That means npm 2FA opens
   the browser, so no OTP is typed on camera and no code leaks into the recording.
4. Confirm `gh auth status` is green and you are on `main` with a clean tree.
5. Rehearse the exact run twice with `shipx --dry-run`. Same UI, same prompts, no side
   effects. This is how the take feels organic: you have done it twice already.
6. Open two things and nothing else: the terminal, and a browser tab on
   `npmjs.com/package/@lacymorrow/shipx` showing 0.1.22.
7. Terminal: 1200 x 760-ish window, font 16 to 18, Catppuccin Mocha or whatever you use
   daily (the gif used Mocha, keep it consistent). Clear the prompt to something short.
   Turn off notifications. `clear` before record.

## Recording rule

The screen is a one-shot. The publish only happens once per version. The voice is
retakeable. So:

- Record the screen once, silently, following the beat sheet below for timing.
- Then narrate over the footage. Two or three takes. Pick the one where you sounded like
  you were talking to a friend, not the one where every word landed.
- If you would rather talk live, do it, but know the screen can't be re-run if you
  flub. The dry-run rehearsals are your insurance.

Tools that work: QuickTime for the screen, then Descript or iMovie for the voice pass.
Screen Studio if you want the cursor zoom, but keep zooms to the prompts, not the spinners.

## Beat sheet (75 seconds)

Speak the beats, not the words. The lines are the idea, in your voice. If a line feels
written, say what it means instead.

| Time | On screen | What you say |
|---|---|---|
| 0:00 | Terminal, cursor blinking in `~/repo/shipx`. Nothing else. | "Every package release is the same nine commands in the same order. Bump, tag, changelog, push, gh release, npm publish. I kept forgetting one, usually the tag." |
| 0:08 | Type `shipx`. Enter. | "So I wrote this. It's shipx, and I'm going to release it with itself." |
| 0:12 | Intro box `shipx — Release`. Preflight spinner. `Preflight OK`. `npm: authenticated as lacymorrow`. | "First it refuses to run if the tree is dirty or I'm on the wrong branch. That alone has saved me." |
| 0:20 | Version prompt: `Current version: 0.1.22. Bump type?` patch / minor / major. Hover on patch. | "Patch, minor, major. It reads the version from package.json, no config." |
| 0:25 | Enter. Confirm prompt `Release 0.1.22 → 0.1.23 (v0.1.23)?` | "One confirm." |
| 0:28 | Enter. `Bumped package.json → 0.1.23`. Changelog box with the real commit lines. | Silence for two seconds. Then: "Changelog comes from the commits since the last tag. That's the GitHub release body." |
| 0:36 | `Committed and tagged v0.1.23`. `Pushed to GitHub`. | "Commit, tag, push. Same as I'd type it. Each step is one shell command, nothing hidden." |
| 0:44 | `GitHub release created`. npm publish spinner. Browser flashes for web auth, approve. | "GitHub release. Then npm. Two-factor pops the browser, that's npm, not me." |
| 0:54 | `Published to npm`. `Verified @lacymorrow/shipx@0.1.23 on the registry`. Outro line. | "And it checks the registry actually has it before it says done." |
| 1:00 | Switch to the browser tab. Reload. Version shows 0.1.23. | "There it is." Beat. |
| 1:05 | Back to terminal. Type `npx @lacymorrow/shipx`. Don't run it. Hold two seconds. | "npx @lacymorrow/shipx. Works on whatever is in your current directory. That's the whole thing." |
| 1:12 | Cut to black. No end card. | (nothing) |

Total spoken words: about 150. If you are over 180, cut lines, not speed.

## Error states (what to do if the take goes sideways)

- Preflight fails (dirty tree, wrong branch): stop recording, fix, start over. Do not show
  it in video 1. It is a great 15-second clip for later.
- Push fails ("Remote has new commits"): shipx offers to pull and retry. Keep rolling,
  say "and it handles that". Use the take if it recovered cleanly.
- npm publish fails: the retry loop appears with four options. Keep rolling. If it
  recovers on Retry, that is a better video than the clean one. If it does not,
  choose rollback, stop, fix auth, start over on the same version.
- Browser 2FA takes too long: cut that stretch in the edit. Nobody needs to watch a
  spinner for 8 seconds.

## Post copy (X)

Every package release is the same nine commands. I kept forgetting the tag.

So I wrote shipx: bump, changelog, tag, push, GitHub release, npm publish, in one prompt.
Refuses to run on a dirty tree. Retries npm publish instead of dying. Cargo and Homebrew too.

Here it is releasing itself.

npx @lacymorrow/shipx

(video attached, no link in the first post; reply with the GitHub link)

## Post copy (LinkedIn)

Same as X, plus one line at the end: "It's ~600 lines of TypeScript, two runtime deps,
MIT. Prior art is sindresorhus/np, which is still great if you only ship to npm."

## After posting

- Re-cut 0:12 to 0:58 as the README gif (or keep VHS, but point `setup-demo.sh` at
  the real repo with `--dry-run`, so the gif shows every step instead of three).
- Save the raw recording to `media/` (not committed, add to .gitignore) so video 2
  can reuse the intro.
- Video 2 is `--multi`: five repos, one run, one browser auth. Open on `cd ~/repo && shipx --multi`.

## Demo test

1. Ten seconds: terminal already open, the pain in one sentence, `shipx` typed by 0:08.
2. Removed: multi, config, beta, dry-run, hooks, Cargo, intro card, face cam, comparison table, Homebrew step. All listed above.
3. One primary action: watch one real release happen. One CTA at the end.
4. Defaults: no config shown, because the defaults carry a plain npm package.
5. States: prep covers preflight; the error-state table covers push and publish failures on camera.
6. Feedback: every step has a spinner. The browser 2FA gap gets cut in the edit.
7. Seams: the browser 2FA popup is one. The narration names it ("that's npm, not me") so it reads as honest, not broken.
8. Stage test: a real tool releasing itself, ending on the npm page. Yes.
9. Evidence: the recording is the evidence. Until it exists this is a plan, not a done.
10. DRI: Lacy.
