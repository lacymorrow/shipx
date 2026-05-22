#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";

const target = "dist/cli.js";
const original = readFileSync(target, "utf8");

const rewritten = original
	.replace("#!/usr/bin/env bun", "#!/usr/bin/env node")
	.replace("// @bun\n", "");

if (!rewritten.startsWith("#!/usr/bin/env node")) {
	const firstLine = rewritten.split("\n", 1)[0];
	throw new Error(
		`postbuild: ${target} does not start with the expected node shebang.\n` +
		`  First line: ${JSON.stringify(firstLine)}\n` +
		`  bun's output format may have changed — update scripts/postbuild.mjs before publishing.`,
	);
}

writeFileSync(target, rewritten);
