#!/usr/bin/env node
// Stands in for a stack-viewer that takes --annotations: its page records its arguments and the annotations.
import { readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
if (args.includes("--help")) {
  process.stdout.write("Usage: stack-viewer [options] [revset]\n      --annotations <file>  What to show on each commit.\n");
  process.exit(0);
}
const out = args[args.indexOf("-o") + 1];
const annotations = readFileSync(args[args.indexOf("--annotations") + 1], "utf8");
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
writeFileSync(out, `<!DOCTYPE html><html><body><pre id="args">${esc(JSON.stringify(args))}</pre><pre id="annotations">${esc(annotations)}</pre></body></html>\n`);
