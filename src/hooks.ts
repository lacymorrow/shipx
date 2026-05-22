import * as p from "@clack/prompts";
import pc from "picocolors";
import type { HookContext, HookFunction, Hooks } from "./types.ts";
import { errorText } from "./utils.ts";

export async function runHook(
	name: keyof Hooks,
	hook: HookFunction | undefined,
	context: HookContext,
): Promise<void> {
	if (!hook) return;
	if (context.config.dryRun) {
		p.log.info(`${pc.dim("[dry-run]")} Would run hook ${pc.yellow(name)}`);
		return;
	}
	const spinner = p.spinner();
	spinner.start(`Running hook ${pc.yellow(name)}`);
	try {
		await hook(context);
		spinner.stop(`Hook ${pc.yellow(name)} completed`);
	} catch (err) {
		spinner.stop(pc.red(`Hook ${pc.yellow(name)} failed: ${errorText(err)}`));
		throw err;
	}
}
