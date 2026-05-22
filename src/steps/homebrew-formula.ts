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

export interface BinaryAssetInfo {
	url: string;
	sha256: string;
}

const PLATFORM_PATTERNS: Record<string, { osPattern: string; archPattern: string }> = {
	"darwin-arm64": { osPattern: "on_macos", archPattern: "(?:Hardware::CPU\\.arm\\?|on_arm)" },
	"darwin-x64":  { osPattern: "on_macos", archPattern: "(?:Hardware::CPU\\.intel\\?|on_intel)" },
	"linux-arm64": { osPattern: "on_linux", archPattern: "(?:Hardware::CPU\\.arm\\?|on_arm)" },
	"linux-x64":   { osPattern: "on_linux", archPattern: "(?:Hardware::CPU\\.intel\\?|on_intel)" },
};

export interface BinaryFormulaResult {
	formula: string;
	updatedPlatforms: string[];
	unmatchedPlatforms: string[];
}

export function updateBinaryFormulaAssets(
	formula: string,
	assets: Record<string, BinaryAssetInfo>,
): BinaryFormulaResult {
	const validKeys = new Set(Object.keys(PLATFORM_PATTERNS));
	const unknownKeys = Object.keys(assets).filter((k) => !validKeys.has(k));
	if (unknownKeys.length) {
		throw new Error(
			`Unknown binary asset platform(s): ${unknownKeys.join(", ")}. ` +
				`Valid keys: ${[...validKeys].join(", ")}`,
		);
	}

	let result = formula;
	const updatedPlatforms: string[] = [];
	const unmatchedPlatforms: string[] = [];

	for (const [key, asset] of Object.entries(assets)) {
		const pm = PLATFORM_PATTERNS[key];
		if (!pm) continue;

		// Match the OS block, then the arch conditional, then the url + sha256 pair.
		// Non-greedy [\s\S]*? ensures we find the nearest match in sequence.
		const pattern = new RegExp(
			`(${pm.osPattern}\\s+do[\\s\\S]*?${pm.archPattern}[\\s\\S]*?url\\s+)"[^"]+"(\\s*\\n\\s*sha256\\s+)"[a-fA-F0-9]{64}"`,
		);

		const newResult = result.replace(pattern, (_match, before: string, between: string) => {
			return `${before}"${asset.url}"${between}"${asset.sha256}"`;
		});

		if (newResult !== result) {
			updatedPlatforms.push(key);
			result = newResult;
		} else {
			unmatchedPlatforms.push(key);
		}
	}

	if (updatedPlatforms.length === 0) {
		throw new Error(
			"Binary formula update failed: could not find any platform-conditional url + sha256 blocks. " +
				"Expected on_macos/on_linux blocks with Hardware::CPU conditionals containing url + sha256 pairs.",
		);
	}

	return { formula: result, updatedPlatforms, unmatchedPlatforms };
}
