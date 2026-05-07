import * as p from "@clack/prompts";
import pc from "picocolors";

export type BumpType = "patch" | "minor" | "major";

export function bumpVersion(current: string, type: BumpType): string {
	const base = current.replace(/-.*$/, "");
	const [major, minor, patch] = base.split(".").map(Number);
	switch (type) {
		case "major":
			return `${major + 1}.0.0`;
		case "minor":
			return `${major}.${minor + 1}.0`;
		case "patch":
			return `${major}.${minor}.${patch + 1}`;
	}
}

export function bumpBeta(current: string, bumpType: BumpType): string {
	const betaMatch = current.match(/^(.+)-beta\.(\d+)$/);
	if (betaMatch) {
		return `${betaMatch[1]}-beta.${Number(betaMatch[2]) + 1}`;
	}
	return `${bumpVersion(current, bumpType)}-beta.0`;
}

export async function pickVersion(
	currentVersion: string,
	argVersion: string | undefined,
	isBeta: boolean,
): Promise<string> {
	if (isBeta) {
		return pickBetaVersion(currentVersion, argVersion);
	}

	if (argVersion === "patch" || argVersion === "minor" || argVersion === "major") {
		return bumpVersion(currentVersion, argVersion);
	}
	if (argVersion && /^\d+\.\d+\.\d+/.test(argVersion)) {
		return argVersion;
	}

	const selected = await p.select({
		message: `Current version: ${pc.cyan(currentVersion)}. Bump type?`,
		options: [
			{
				value: "patch" as const,
				label: "patch",
				hint: `${currentVersion} → ${bumpVersion(currentVersion, "patch")}`,
			},
			{
				value: "minor" as const,
				label: "minor",
				hint: `${currentVersion} → ${bumpVersion(currentVersion, "minor")}`,
			},
			{
				value: "major" as const,
				label: "major",
				hint: `${currentVersion} → ${bumpVersion(currentVersion, "major")}`,
			},
		],
	});

	if (p.isCancel(selected)) {
		p.cancel("Release cancelled.");
		process.exit(0);
	}
	return bumpVersion(currentVersion, selected);
}

async function pickBetaVersion(currentVersion: string, argVersion: string | undefined): Promise<string> {
	const isAlreadyBeta = /-beta\.\d+$/.test(currentVersion);

	if (isAlreadyBeta) {
		const selected = await p.select({
			message: `Current version: ${pc.cyan(currentVersion)}. Beta bump?`,
			options: [
				{
					value: "next" as const,
					label: "next beta",
					hint: `${currentVersion} → ${bumpBeta(currentVersion, "patch")}`,
				},
				{
					value: "patch" as const,
					label: "new patch beta",
					hint: `${currentVersion} → ${bumpVersion(currentVersion, "patch")}-beta.0`,
				},
				{
					value: "minor" as const,
					label: "new minor beta",
					hint: `${currentVersion} → ${bumpVersion(currentVersion, "minor")}-beta.0`,
				},
				{
					value: "major" as const,
					label: "new major beta",
					hint: `${currentVersion} → ${bumpVersion(currentVersion, "major")}-beta.0`,
				},
			],
		});

		if (p.isCancel(selected)) {
			p.cancel("Release cancelled.");
			process.exit(0);
		}
		return selected === "next"
			? bumpBeta(currentVersion, "patch")
			: `${bumpVersion(currentVersion, selected)}-beta.0`;
	}

	if (argVersion === "patch" || argVersion === "minor" || argVersion === "major") {
		return bumpBeta(currentVersion, argVersion);
	}

	const selected = await p.select({
		message: `Current version: ${pc.cyan(currentVersion)}. Bump type for beta?`,
		options: [
			{
				value: "patch" as const,
				label: "patch",
				hint: `${currentVersion} → ${bumpBeta(currentVersion, "patch")}`,
			},
			{
				value: "minor" as const,
				label: "minor",
				hint: `${currentVersion} → ${bumpBeta(currentVersion, "minor")}`,
			},
			{
				value: "major" as const,
				label: "major",
				hint: `${currentVersion} → ${bumpBeta(currentVersion, "major")}`,
			},
		],
	});

	if (p.isCancel(selected)) {
		p.cancel("Release cancelled.");
		process.exit(0);
	}
	return bumpBeta(currentVersion, selected);
}
