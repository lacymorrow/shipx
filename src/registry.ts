import * as p from "@clack/prompts";
import pc from "picocolors";
import { errorText, exec } from "./utils.ts";

/**
 * Fetches the latest version of a package from the npm registry.
 * Returns null if the package is not published, the network call failed,
 * or `npm view` produced no output.
 */
export function getNpmRegistryVersion(pkgName: string, cwd?: string): string | null {
	try {
		const out = exec("npm", ["view", pkgName, "version"], { cwd }).trim();
		return out || null;
	} catch {
		return null;
	}
}

/**
 * Compare two semver strings. Returns 1 if a > b, -1 if a < b, 0 if equal.
 * Handles pre-release suffixes per semver 2.0: a version with no pre-release
 * ranks higher than the same version with a pre-release. Pre-release identifiers
 * are compared piece by piece; numeric pieces compare numerically.
 */
export function compareSemver(a: string, b: string): number {
	const [aMain, aPre] = splitVersion(a);
	const [bMain, bPre] = splitVersion(b);

	const [a1, a2, a3] = aMain.split(".").map((s) => Number(s) || 0);
	const [b1, b2, b3] = bMain.split(".").map((s) => Number(s) || 0);

	if (a1 !== b1) return a1 > b1 ? 1 : -1;
	if (a2 !== b2) return a2 > b2 ? 1 : -1;
	if (a3 !== b3) return a3 > b3 ? 1 : -1;

	if (!aPre && bPre) return 1;
	if (aPre && !bPre) return -1;
	if (!aPre && !bPre) return 0;

	const aParts = aPre.split(".");
	const bParts = bPre.split(".");
	for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
		const ap = aParts[i];
		const bp = bParts[i];
		if (ap === undefined) return -1;
		if (bp === undefined) return 1;
		const an = Number(ap);
		const bn = Number(bp);
		const aNum = !Number.isNaN(an) && /^\d+$/.test(ap);
		const bNum = !Number.isNaN(bn) && /^\d+$/.test(bp);
		if (aNum && bNum) {
			if (an !== bn) return an > bn ? 1 : -1;
		} else if (aNum !== bNum) {
			// Numeric identifiers always have lower precedence than alphanumeric.
			return aNum ? -1 : 1;
		} else if (ap !== bp) {
			return ap > bp ? 1 : -1;
		}
	}
	return 0;
}

function splitVersion(v: string): [string, string] {
	const idx = v.indexOf("-");
	if (idx === -1) return [v, ""];
	return [v.slice(0, idx), v.slice(idx + 1)];
}

/**
 * If the npm registry has a higher version than the local package.json,
 * warn and prompt the user to use the registry version as the base for the
 * next bump. Returns the version to use as the bump base.
 *
 * Skips silently when:
 *   - the registry is unreachable or the package is unpublished (returns local),
 *   - the registry version is equal to or below local (returns local).
 */
export async function reconcileRegistryVersion(
	pkgName: string,
	localVersion: string,
	cwd: string,
	options: { displayName?: string } = {},
): Promise<string> {
	const displayName = options.displayName ?? pkgName;

	const spinner = p.spinner();
	spinner.start(`Checking npm registry for ${displayName}`);
	const registryVersion = getNpmRegistryVersion(pkgName, cwd);
	if (!registryVersion) {
		spinner.stop(pc.dim(`npm registry: no published version found for ${displayName}`));
		return localVersion;
	}
	spinner.stop(`npm registry latest: ${pc.cyan(registryVersion)}`);

	if (compareSemver(registryVersion, localVersion) <= 0) {
		return localVersion;
	}

	p.log.warn(
		`${pc.cyan(displayName)} on npm is ${pc.green(registryVersion)} but local is ${pc.yellow(localVersion)}.\n` +
		`  Bumping from ${localVersion} would publish a version below the registry and be rejected by npm.`,
	);

	const choice = await p.select({
		message: "Use which version as the base for bumping?",
		options: [
			{
				value: "registry" as const,
				label: `Registry version (${registryVersion})`,
				hint: "recommended — avoids npm rejecting the publish",
			},
			{
				value: "local" as const,
				label: `Local version (${localVersion})`,
				hint: "publish will likely fail",
			},
		],
		initialValue: "registry" as const,
	});

	if (p.isCancel(choice)) {
		p.cancel("Release cancelled.");
		process.exit(0);
	}

	return choice === "registry" ? registryVersion : localVersion;
}
