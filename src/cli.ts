#!/usr/bin/env node
import * as p from "@clack/prompts";
import pc from "picocolors";

p.intro(pc.magenta(pc.bold("  shipx  ")));
p.log.info("shipx is under active development. Check back soon!");
p.log.info(pc.dim("https://github.com/lacymorrow/shipx"));
p.outro(pc.green("v0.0.1"));
