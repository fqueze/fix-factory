import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { generate, renderPromptsDoc } from "./prompts-doc.ts";

test("docs/PROMPTS.md is up to date (run node src/tools/prompts-doc.ts)", () => {
  const current = readFileSync(fileURLToPath(new URL("../../docs/PROMPTS.md", import.meta.url)), "utf8");
  assert.equal(current, generate());
});

test("a prompt missing from the index is reported", () => {
  assert.throws(() => renderPromptsDoc({}, { a: "text" }), /no entry for a/);
});
