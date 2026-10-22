import { test } from "node:test";
import assert from "node:assert/strict";
import { parseConstants, parseGeckoFormat, pinnedProfilerRev } from "./tools.ts";

test("profile versions: what the profiler reads, which profiler CI uses, what Gecko writes", () => {
  assert.deepEqual(parseConstants("// x\nexport const GECKO_PROFILE_VERSION = 37;\n\nexport const PROCESSED_PROFILE_VERSION = 76;\n"), { gecko: 37, processed: 76 });
  const rev = "d019001a67a2d34ca2276ece14e9a60a29e671ef";
  assert.equal(pinnedProfilerRev(`other:\n    fetch:\n        repo: https://github.com/x/y\n        revision: ${"0".repeat(40)}\nfirefox-profiler:\n    description: firefox profiler source code\n    fetch:\n        type: git\n        repo: https://github.com/firefox-devtools/profiler\n        revision: ${rev}\n`), rev);
  assert.equal(parseGeckoFormat("const int GECKO_PROFILER_FORMAT_VERSION = 36;"), 36);
});
