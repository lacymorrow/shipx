// shipx releases itself with this file. There is no Homebrew formula for shipx,
// so the Homebrew step is off. Nothing here is delegated to a tag-triggered CI
// run, so there is nothing to watch after the push.
export default {
	steps: { homebrew: false, watchCi: false },
};
