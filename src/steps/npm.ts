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

export async function publishNpm(
	config: ResolvedConfig,
	isBeta: boolean,
	otp?: string,
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

	const baseArgs = ["publish", "--access", access, ...(isBeta ? ["--tag", "beta"] : [])];
	if (otp) baseArgs.push("--otp", otp);

	const spinner = p.spinner();
	spinner.start(`Publishing to npm${isBeta ? " (beta)" : ""}`);

	try {
		exec("npm", baseArgs, { cwd });
		spinner.stop(pc.green(`Published to npm${isBeta ? " (beta)" : ""}`));
		return true;
	} catch (err) {
		spinner.stop(pc.yellow("npm publish failed"));
		p.log.message(pc.dim(errorText(err)));

		if (isAuthError(err)) {
			p.log.warn("This looks like an authentication error — try logging in first");
		}
	}

	while (true) {
		const action = await p.select({
			message: "How would you like to proceed?",
			options: [
				{ value: "otp" as const, label: "Enter OTP", hint: "publish with one-time password" },
				{ value: "login" as const, label: "Log in to npm", hint: "run npm login, then retry" },
				{ value: "retry" as const, label: "Retry publish", hint: "try again without OTP" },
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

		const retryArgs = ["publish", "--access", access, ...(isBeta ? ["--tag", "beta"] : [])];
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
