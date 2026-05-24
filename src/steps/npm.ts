import * as p from "@clack/prompts";
import pc from "picocolors";
import { resolve } from "node:path";
import type { NpmTarget, ResolvedConfig } from "../types.ts";
import { errorText, exec, readJson } from "../utils.ts";

function isNpmLoggedIn(cwd?: string): string | false {
	try {
		return exec("npm", ["whoami"], { cwd }).trim();
	} catch {
		return false;
	}
}

function isAuthError(err: unknown): boolean {
	const text = errorText(err);
	return /E401|E403|E404|ENEEDAUTH|not logged in/i.test(text);
}

function isOtpError(err: unknown): boolean {
	const text = errorText(err);
	return /EOTP|one-time password/i.test(text);
}

async function ensureNpmAuth(cwd?: string): Promise<boolean> {
	const user = isNpmLoggedIn(cwd);
	if (user) {
		p.log.info(`npm authenticated as ${pc.cyan(user)}`);
		return true;
	}

	p.log.warn("Not logged in to npm");
	const action = await p.confirm({
		message: "Log in to npm now?",
		initialValue: true,
	});

	if (p.isCancel(action) || !action) return false;

	p.log.info("Running npm login...");
	try {
		exec("npm", ["login"], { cwd, stdio: "inherit" });
	} catch {
		p.log.error("npm login failed");
		return false;
	}

	const after = isNpmLoggedIn(cwd);
	if (after) {
		p.log.success(`Logged in as ${pc.cyan(after)}`);
		return true;
	}
	p.log.error("Still not logged in after npm login");
	return false;
}

function publishArgs(access: string, isBeta: boolean, distTag?: string): string[] {
	const tag = distTag ?? (isBeta ? "beta" : undefined);
	return ["publish", "--access", access, ...(tag ? ["--tag", tag] : [])];
}

function tryWebPublish(args: string[], cwd?: string): boolean {
	try {
		exec("npm", [...args, "--auth-type", "web"], { cwd, stdio: "inherit" });
		return true;
	} catch {
		return false;
	}
}

function targetDisplayName(target: NpmTarget): string {
	try {
		const pkg = readJson(resolve(target.cwd, "package.json"));
		if (typeof pkg.name === "string") return pkg.name;
	} catch { /* fall through */ }
	return target.cwd;
}

/**
 * After a successful `npm publish`, ask the registry what it actually has
 * for `<name>@<version>` and warn if the published artifact is missing
 * entry points that exist locally — the lacy-style "no bin field on npm"
 * disaster (LAC-2055). Best-effort: warns but never fails the release,
 * since the registry can lag and offline environments shouldn't break.
 */
export function verifyPublishedArtifact(cwd: string): void {
	let localPkg: Record<string, unknown>;
	try {
		localPkg = readJson(resolve(cwd, "package.json"));
	} catch {
		return;
	}
	if (typeof localPkg.name !== "string" || typeof localPkg.version !== "string") return;
	const name = localPkg.name;
	const version = localPkg.version;

	let raw: string;
	try {
		raw = exec("npm", ["view", `${name}@${version}`, "bin", "main", "--json"], { cwd });
	} catch {
		// Registry lag / network / package not found — don't fail the release.
		p.log.warn(
			`Could not verify ${pc.cyan(`${name}@${version}`)} on the registry (npm view failed).\n` +
			`  Manually verify with ${pc.green(`npm view ${name}@${version}`)} once propagation completes.`,
		);
		return;
	}

	let view: Record<string, unknown>;
	try {
		view = JSON.parse(raw.trim() || "{}");
	} catch {
		return;
	}

	const mismatches: string[] = [];

	const hasLocalBin = Boolean(localPkg.bin);
	const hasRegistryBin = Boolean(view.bin);
	if (hasLocalBin && !hasRegistryBin) {
		mismatches.push(`local has "bin" but registry version has none`);
	}

	if (typeof localPkg.main === "string" && typeof view.main !== "string") {
		mismatches.push(`local has "main": "${localPkg.main}" but registry version has none`);
	}

	if (mismatches.length) {
		p.log.warn(
			`Published ${pc.cyan(`${name}@${version}`)} doesn't match the local package:\n` +
			mismatches.map((m) => `  ${pc.yellow("●")} ${m}`).join("\n") + "\n" +
			`  This usually means a different package.json was published than expected — verify the package on npm before relying on it.`,
		);
	}
}

async function publishMultipleTargets(
	targets: NpmTarget[],
	isBeta: boolean,
	opts?: { otp?: string; webAuth?: boolean; distTag?: string },
): Promise<boolean> {
	if (!await ensureNpmAuth(targets[0].cwd)) {
		const skip = await p.confirm({
			message: "Continue without npm login?",
			initialValue: false,
		});
		if (p.isCancel(skip) || !skip) {
			p.log.info("Skipping npm publish");
			return false;
		}
	}

	p.log.info(`Publishing ${pc.cyan(String(targets.length))} npm packages`);

	let otp = opts?.otp;
	let webAuth = opts?.webAuth ?? false;

	if (!otp && !webAuth) {
		const authMethod = await p.select({
			message: `Authentication for ${targets.length} packages`,
			options: [
				{ value: "web" as const, label: "Web auth (passkey)", hint: "authenticate each publish in browser" },
				{ value: "otp" as const, label: "Enter OTP", hint: "reused across all targets" },
				{ value: "none" as const, label: "No auth needed", hint: "token already configured" },
			],
		});

		if (p.isCancel(authMethod)) {
			p.log.info("Skipping npm publish");
			return false;
		}

		if (authMethod === "otp") {
			const otpInput = await p.text({
				message: "npm OTP (reused for all targets)",
				placeholder: "123456",
				validate: (v) => {
					if (!v || !/^\d{6}$/.test(v.trim())) return "OTP must be 6 digits";
				},
			});
			if (p.isCancel(otpInput)) {
				p.log.info("Skipping npm publish");
				return false;
			}
			otp = otpInput.trim();
		} else if (authMethod === "web") {
			webAuth = true;
		}
	}

	let remaining = [...targets];
	const results = new Map<NpmTarget, { name: string; success: boolean }>();
	const displayNames = new Map<NpmTarget, string>();

	for (const target of targets) {
		displayNames.set(target, targetDisplayName(target));
	}

	while (remaining.length > 0) {
		const failed: NpmTarget[] = [];

		for (const target of remaining) {
			const displayName = displayNames.get(target) ?? target.cwd;
			const args = publishArgs(target.access, isBeta, opts?.distTag);

			if (webAuth) {
				p.log.message(`  ${pc.cyan("→")} ${displayName}`);
				if (tryWebPublish(args, target.cwd)) {
					p.log.success(`  Published ${pc.green(displayName)}`);
					results.set(target, { name: displayName, success: true });
					verifyPublishedArtifact(target.cwd);
				} else {
					p.log.error(`  Failed to publish ${displayName}`);
					results.set(target, { name: displayName, success: false });
					failed.push(target);
				}
				continue;
			}

			const attemptArgs = [...args];
			if (otp) attemptArgs.push("--otp", otp);

			const spinner = p.spinner();
			spinner.start(`Publishing ${displayName}`);
			try {
				exec("npm", attemptArgs, { cwd: target.cwd });
				spinner.stop(pc.green(`Published ${displayName}`));
				results.set(target, { name: displayName, success: true });
				verifyPublishedArtifact(target.cwd);
			} catch (err) {
				spinner.stop(pc.red(`Failed to publish ${displayName}`));
				p.log.message(pc.dim(errorText(err)));
				results.set(target, { name: displayName, success: false });
				failed.push(target);
			}
		}

		if (failed.length === 0) break;

		p.log.warn(`${failed.length} target(s) failed: ${failed.map((t) => pc.yellow(displayNames.get(t) ?? t.cwd)).join(", ")}`);

		const action = await p.select({
			message: "How would you like to proceed?",
			options: [
				{ value: "otp" as const, label: "Retry with new OTP", hint: "enter a fresh code and retry failed targets" },
				{ value: "web" as const, label: "Retry with web auth", hint: "authenticate each in browser" },
				{ value: "retry" as const, label: "Retry as-is", hint: "retry without changing auth" },
				{ value: "skip" as const, label: "Skip failed targets", hint: "continue to next step" },
			],
		});

		if (p.isCancel(action) || action === "skip") break;

		if (action === "otp") {
			const newOtp = await p.text({
				message: "npm OTP",
				placeholder: "123456",
				validate: (v) => {
					if (!v || !/^\d{6}$/.test(v.trim())) return "OTP must be 6 digits";
				},
			});
			if (p.isCancel(newOtp)) break;
			otp = newOtp.trim();
			webAuth = false;
		} else if (action === "web") {
			webAuth = true;
			otp = undefined;
		}

		remaining = failed;
	}

	const finalResults = Array.from(results.values());
	const succeeded = finalResults.filter((r) => r.success);
	const failedResults = finalResults.filter((r) => !r.success);
	if (succeeded.length) {
		p.log.success(`Published: ${succeeded.map((r) => pc.green(r.name)).join(", ")}`);
	}
	if (failedResults.length) {
		p.log.warn(`Failed: ${failedResults.map((r) => pc.yellow(r.name)).join(", ")}`);
	}

	return failedResults.length === 0;
}

export async function publishNpm(
	config: ResolvedConfig,
	isBeta: boolean,
	opts?: { otp?: string; webAuth?: boolean; distTag?: string },
): Promise<boolean> {
	if (config.npm.targets.length > 1) {
		return publishMultipleTargets(config.npm.targets, isBeta, opts);
	}

	const { cwd, access } = config.npm.targets[0];

	if (!await ensureNpmAuth(cwd)) {
		const skip = await p.confirm({
			message: "Continue without npm login?",
			initialValue: false,
		});
		if (p.isCancel(skip) || !skip) {
			p.log.info("Skipping npm publish");
			return false;
		}
	}

	const baseArgs = publishArgs(access, isBeta, opts?.distTag);

	if (opts?.webAuth) {
		p.log.info("Publishing to npm with browser authentication…");
		if (tryWebPublish(baseArgs, cwd)) {
			p.log.success(pc.green(`Published to npm${isBeta ? " (beta)" : ""}`));
			verifyPublishedArtifact(cwd);
			return true;
		}
		p.log.error("npm publish with web auth failed");
	} else {
		const attemptArgs = [...baseArgs];
		if (opts?.otp) attemptArgs.push("--otp", opts.otp);

		const spinner = p.spinner();
		spinner.start(`Publishing to npm${isBeta ? " (beta)" : ""}`);

		try {
			exec("npm", attemptArgs, { cwd });
			spinner.stop(pc.green(`Published to npm${isBeta ? " (beta)" : ""}`));
			verifyPublishedArtifact(cwd);
			return true;
		} catch (err) {
			spinner.stop(pc.yellow("npm publish failed"));
			p.log.message(pc.dim(errorText(err)));

			if (isOtpError(err)) {
				p.log.warn("npm requires authentication — use web auth (passkeys) or enter an OTP code");
			} else if (isAuthError(err)) {
				p.log.warn("This looks like an authentication error — try logging in first");
			}
		}
	}

	while (true) {
		const action = await p.select({
			message: "How would you like to proceed?",
			options: [
				{ value: "web" as const, label: "Web auth (passkey)", hint: "open browser to authenticate and publish" },
				{ value: "otp" as const, label: "Enter OTP", hint: "publish with one-time password" },
				{ value: "login" as const, label: "Log in to npm", hint: "run npm login, then retry" },
				{ value: "retry" as const, label: "Retry publish", hint: "try again without auth" },
				{ value: "skip" as const, label: "Skip npm publish", hint: "continue to next step" },
			],
		});

		if (p.isCancel(action) || action === "skip") {
			p.log.info("Skipping npm publish");
			return false;
		}

		if (action === "login") {
			p.log.info("Running npm login...");
			try {
				exec("npm", ["login"], { cwd, stdio: "inherit" });
				p.log.success("Logged in to npm");
			} catch {
				p.log.error("npm login failed");
			}
			continue;
		}

		if (action === "web") {
			p.log.info("Opening browser for authentication…");
			if (tryWebPublish(baseArgs, cwd)) {
				p.log.success(pc.green("Published to npm"));
				verifyPublishedArtifact(cwd);
				return true;
			}
			p.log.error("npm publish with web auth failed");
			continue;
		}

		const retryArgs = [...baseArgs];
		if (action === "otp") {
			const newOtp = await p.text({
				message: "npm OTP",
				placeholder: "123456",
				validate: (v) => {
					if (!v || !/^\d{6}$/.test(v.trim())) return "OTP must be 6 digits";
				},
			});
			if (p.isCancel(newOtp)) continue;
			retryArgs.push("--otp", newOtp.trim());
		}

		const retrySpinner = p.spinner();
		retrySpinner.start("Publishing to npm");
		try {
			exec("npm", retryArgs, { cwd });
			retrySpinner.stop(pc.green("Published to npm"));
			verifyPublishedArtifact(cwd);
			return true;
		} catch (err) {
			retrySpinner.stop(pc.red("npm publish failed"));
			p.log.message(pc.dim(errorText(err)));
		}
	}
}
