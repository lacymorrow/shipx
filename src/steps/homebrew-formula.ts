export function updateFormulaUrlAndSha(
	formula: string,
	newUrl: string,
	newSha: string,
): string {
	// Paired regex: match a GitHub url line immediately followed by a bare sha256 line.
	// "Bare" means `sha256 "hex"` — not `sha256 cellar: ...` (bottle blocks).
	// Supports archive/refs/tags/ and releases/download/ URL formats.
	const pattern =
		/([ \t]*url\s+)"https:\/\/github\.com\/[^"]+\.tar\.gz"(\s*\n)([ \t]*sha256\s+)"[a-f0-9]{64}"/;

	const updated = formula.replace(pattern, `$1"${newUrl}"$2$3"${newSha}"`);

	if (updated === formula) {
		throw new Error(
			"Homebrew formula update failed: could not find paired url + sha256 lines matching a GitHub tarball URL. " +
				"The formula may use an unexpected URL format or have sha256 on a non-adjacent line.",
		);
	}

	return updated;
}
