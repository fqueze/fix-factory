// Commit message parsing and editing.

export const PLACEHOLDER_RE = /\bBug X{3,}\b/gi;
const REVISION_RE = /^Differential Revision: (https?:\/\/\S+\/D(\d+))\s*$/m;
export const TITLE_FORMAT_RE = /^Bug \d+ - \S.*, r=[^\s,]+(,[^\s,]+)*\.$/;

// The bug number in the title; null for "Bug XXXXXXX" or no bug at all.
export function parseBug(title: string): number | null {
  const m = /^Bug (\d+)\b/i.exec(title.trim());
  return m ? Number(m[1]) : null;
}

// Reviewers from "r=a,#group." (also "r?"), in order. Blocking markers ("!") are dropped.
export function parseReviewers(title: string): string[] {
  const out: string[] = [];
  for (const m of title.matchAll(/(?:^|[\s,])r[=?]([#\w.!-]+(?:,[#\w.!-]+)*)/g)) {
    for (const name of m[1].split(",")) {
      const n = name.replace(/[.!]+$/, "").replace(/!/g, "");
      if (n && !out.includes(n)) out.push(n);
    }
  }
  return out;
}

export function parseRevision(message: string): number | undefined {
  const m = REVISION_RE.exec(message);
  return m ? Number(m[2]) : undefined;
}

export function revisionTrailer(message: string): string | undefined {
  const m = REVISION_RE.exec(message);
  return m ? m[0].trim() : undefined;
}

// Test-only heuristic: every changed file is a test or a test manifest. A file counts when one of
// its directories is a test directory (test, tests, mochitest, crashtests, reftests, gtest...), its
// name is a test manifest (browser.toml, xpcshell.ini, reftest.list...). Under testing/, only
// web-platform-tests and their expectations (testing/web-platform/{tests,meta}) count: the rest is
// harness code (testing/mochitest...), which affects every test and isn't reviewed like a test change.
const TEST_DIRS = new Set(["test", "tests", "mochitest", "mochitests", "crashtest", "crashtests", "reftest", "reftests", "gtest", "gtests", "xpcshell"]);
const MANIFEST_RE = /^(browser|xpcshell|mochitest|chrome|a11y|plain|unit|test)[\w-]*\.(toml|ini)$|^(reftest|crashtests)\.list$/;

export function isTestFile(path: string): boolean {
  if (path.startsWith("testing/")) return /^testing\/web-platform\/(meta|tests)\//.test(path);
  const parts = path.split("/");
  const name = parts.pop()!;
  return MANIFEST_RE.test(name) || parts.some((d) => TEST_DIRS.has(d));
}

export function isTestOnly(files: string[]): boolean {
  return files.length > 0 && files.every(isTestFile);
}

export interface MessageEdit {
  bug?: number; // replaces "Bug XXXXXXX" everywhere, and the title's bug number
  message?: string; // a whole new message; the Differential Revision trailer is kept if it lacks one
  diff?: string; // unified diff applied on top of the patch (a reviewer's suggested edit)
}

export function editMessage(message: string, edit: MessageEdit): string {
  let out = edit.message ?? message;
  if (edit.bug !== undefined) {
    const lines = out.split("\n");
    lines[0] = lines[0].replace(/^Bug (\d+|X+)\b/i, `Bug ${edit.bug}`);
    out = lines.join("\n").replace(PLACEHOLDER_RE, `Bug ${edit.bug}`);
  }
  const trailer = revisionTrailer(message);
  if (trailer && !revisionTrailer(out)) {
    out = out.trimEnd() + "\n\n" + trailer + "\n";
  }
  if (!out.endsWith("\n")) out += "\n";
  return out;
}
