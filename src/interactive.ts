/**
 * Whether shipx may stop and ask a person something.
 *
 * A release is one of the few commands worth interrupting for, so shipx asks
 * by default. It cannot ask in CI, where there is no one to answer: the prompt
 * renders, nothing arrives on stdin, and the release stops there having done
 * nothing (lacymorrow/shipx#64).
 */

/** Set by `--yes` / `-y`. Forces every confirm to its safe answer. */
let forcedYes = false;

export function setAssumeYes(value: boolean): void {
	forcedYes = value;
}

export function assumeYes(): boolean {
	return forcedYes;
}

/**
 * True when nobody is there to answer a prompt.
 *
 * `--yes` is explicit and wins outright. Otherwise this is a guess, and it is
 * made from two signals because neither is reliable alone: `CI` is set by every
 * major runner but by nothing when you pipe shipx into a script locally, and a
 * non-TTY stdin catches that case but is also true under some editors and
 * terminal multiplexers where a person *is* watching.
 *
 * Guessing wrong in the cautious direction costs a hung CI job, which is the
 * bug being fixed. Guessing wrong the other way releases without a confirm,
 * which is why the version to release must still be named explicitly: see
 * `canAutoConfirmRelease`.
 */
export function isNonInteractive(): boolean {
	if (forcedYes) return true;
	if (process.env.CI && process.env.CI !== "false") return true;
	return !process.stdin.isTTY;
}

/**
 * Whether the "Release X → Y?" confirm may answer itself.
 *
 * Only when the bump was named on the command line. `shipx` with no argument
 * asks which bump to make, and a run that had to guess the version is not one
 * to also auto-approve. `shipx patch` in a workflow has already said what it
 * wants and has nothing left to confirm.
 *
 * `--yes` overrides this: someone typed it on purpose.
 */
export function canAutoConfirmRelease(bumpWasNamed: boolean): boolean {
	if (forcedYes) return true;
	return bumpWasNamed && isNonInteractive();
}
