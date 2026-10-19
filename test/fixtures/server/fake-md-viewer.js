#!/usr/bin/env node
// Stands in for md-viewer (-n: a standalone page in the temp directory, its file:// URL printed) and
// diff-viewer (-o <file>) in tests; the page shows the arguments and the file's text.
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const page = `<!DOCTYPE html><pre id="args">${JSON.stringify(args)}</pre><pre id="text">${readFileSync(args.at(-1), "utf8")}</pre>\n`;
if (args.includes("-o")) {
  writeFileSync(args[args.indexOf("-o") + 1], page);
} else {
  const out = join(tmpdir(), `fake-md-viewer-${process.pid}.html`);
  writeFileSync(out, page);
  process.stdout.write(`${pathToFileURL(out)}\n`);
}
