import * as p from "@clack/prompts";
import pc from "picocolors";
import type { ResolvedConfig } from "../types.ts";
import { errorText, exec } from "../utils.ts";

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

export async function publishNpm(
	config: ResolvedConfig,
	isBeta: boolean,
	opts?: { otp?: string; webAuth?: boolean; distTag?: string },
): Promise<boolean> {
	const { cwd, access } = config.npm;

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
			return true;
		} catch (err) {
			retrySpinner.stop(pc.red("npm publish failed"));
			p.log.message(pc.dim(errorText(err)));
		}
	}
}
