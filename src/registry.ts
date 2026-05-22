import * as p from "@clack/prompts";
import pc from "picocolors";
import { errorText, exec } from "./utils.ts";

export type NpmRegistryResult =
	| { kind: "ok"; version: string }
	| { kind: "not-published" }
	| { kind: "network-error"; message: string };

/**
 * Decide whether an `npm view` error means the package isn't published
 * (404 / not found) or that the registry call itself failed (network,
 * auth, registry down). Network errors must surface loudly — silently
 * collapsing them lets shipx bump from a stale local version and publish
 * something that may already exist on the registry.
 */
export function classifyNpmViewError(stderr: string): "not-published" | "network-error" {
	const text = stderr ?? "";
	if (/E404|code\s*404|is\s+not\s+in\s+(?:this|the)\s+npm\s+registry|404\s+Not\s+Found/i.test(text)) {
		return "not-published";
	}
	return "network-error";
}

/**
 * Fetches the latest version of a package from the npm registry. Returns
 * a tagged result distinguishing a successful lookup, an unpublished
 * package (404), and a network/registry failure.
 */
export function getNpmRegistryVersion(pkgName: string, cwd?: string): NpmRegistryResult {
	try {
		const out = exec("npm", ["view", pkgName, "version"], { cwd }).trim();
		if (!out) return { kind: "not-published" };
		return { kind: "ok", version: out };
	} catch (err) {
		const text = errorText(err);
		if (classifyNpmViewError(text) === "not-published") {
			return { kind: "not-published" };
		}
		return { kind: "network-error", message: text };
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
 * Returns local version when:
 *   - the package is unpublished (silent — first release),
 *   - the registry is unreachable (loud warning — could collide on publish),
 *   - the registry version is equal to or below local.
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
	const result = getNpmRegistryVersion(pkgName, cwd);

	if (result.kind === "not-published") {
		spinner.stop(pc.dim(`npm registry: no published version found for ${displayName}`));
		return localVersion;
	}

	if (result.kind === "network-error") {
		spinner.stop(pc.yellow(`npm registry: lookup failed for ${displayName}`));
		p.log.warn(
			`Could not reach the npm registry to verify the published version of ${pc.cyan(displayName)}.\n` +
			`  Using local ${pc.yellow(localVersion)} as the bump base. ` +
			`If the registry has a higher version, npm will reject the publish.\n` +
			`  ${pc.dim(result.message.split("\n")[0])}`,
		);
		return localVersion;
	}

	const registryVersion = result.version;
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
