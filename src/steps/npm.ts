import * as p from "@clack/prompts";
import pc from "picocolors";
import type { ResolvedConfig } from "../types.ts";
import { errorText, exec } from "../utils.ts";

export async function publishNpm(
	config: ResolvedConfig,
	isBeta: boolean,
): Promise<boolean> {
	const { cwd, access } = config.npm;
	const baseArgs = ["publish", "--access", access, ...(isBeta ? ["--tag", "beta"] : [])];

	const spinner = p.spinner();
	spinner.start(`Publishing to npm${isBeta ? " (beta)" : ""}`);

	try {
		exec("npm", baseArgs, { cwd });
		spinner.stop(pc.green(`Published to npm${isBeta ? " (beta)" : ""}`));
		return true;
	} catch (err) {
		spinner.stop(pc.yellow("npm publish failed"));
		p.log.message(pc.dim(errorText(err)));
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

		const retryArgs = [...baseArgs];
		if (action === "otp") {
			const otp = await p.text({
				message: "npm OTP",
				placeholder: "123456",
				validate: (v) => {
					if (!v || !/^\d{6}$/.test(v.trim())) return "OTP must be 6 digits";
				},
			});
			if (p.isCancel(otp)) continue;
			retryArgs.push("--otp", otp.trim());
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
