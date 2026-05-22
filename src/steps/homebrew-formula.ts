// Escape `$` so dynamic strings inserted into a String.replace() replacement
// don't get interpreted as backreferences ($1, $&, $`, $', $$).
function escapeReplacement(value: string): string {
	return value.replace(/\$/g, "$$$$");
}

export function updateFormulaUrlAndSha(
	formula: string,
	newUrl: string,
	newSha: string,
): string {
	// Paired regex: match a GitHub url line immediately followed (same line or next line,
	// no blank lines) by a bare sha256 line. "Bare" means `sha256 "hex"` — not
	// `sha256 cellar: ...` (bottle blocks). Supports archive/refs/tags/ and
	// releases/download/ URL formats. sha256 hex is case-insensitive.
	const pattern =
		/([ \t]*url\s+)"https:\/\/github\.com\/[^"]+\.tar\.gz"([ \t]*\n)([ \t]*sha256\s+)"[a-fA-F0-9]{64}"/;

	const safeUrl = escapeReplacement(newUrl);
	const safeSha = escapeReplacement(newSha);
	const updated = formula.replace(pattern, `$1"${safeUrl}"$2$3"${safeSha}"`);

	if (updated === formula) {
		throw new Error(
			"Homebrew formula update failed: could not find paired url + sha256 lines matching a GitHub tarball URL. " +
				"The formula may use an unexpected URL format or have sha256 on a non-adjacent line.",
		);
	}

	return updated;
}
