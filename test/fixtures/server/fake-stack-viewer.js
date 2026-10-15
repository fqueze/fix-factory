#!/usr/bin/env node
// Stands in for stack-viewer in tests: writes the page given by -o, recording its
// arguments, and fails when the range contains "fail".
import { writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const out = args[args.indexOf("-o") + 1];
const range = args.at(-1);
if (range.includes("fail")) {
  process.stderr.write("fatal: bad revision\n");
  process.exit(128);
}
writeFileSync(out, `<!DOCTYPE html><html><body><pre id="args">${JSON.stringify(args).replace(/</g, "&lt;")}</pre></body></html>\n`);
