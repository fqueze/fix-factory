import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { reviewPages, type ReviewApi } from "./review-pages.ts";

// md-viewer's API, counting what it is asked to read and build.
function fakeApi() {
  const calls = { read: [] as string[][], versions: 0, pages: 0 };
  const api: ReviewApi = {
    findStackRepository: (dir) => ({ root: dir, kind: "git" }),
    openStack: async (found) => ({ root: found.root, list: async () => [{ sha: "a".repeat(40), label: "aaaa" }, { sha: "b".repeat(40), label: "bbbb" }] }),
    readStack: async (_stack, commits) => {
      calls.read.push(commits.map((c) => c.sha[0]));
      return commits.map((c) => ({ ...c, source: `source of ${c.sha[0]}` }));
    },
    readFileVersions: async () => {
      calls.versions++;
      return [{}];
    },
    commitSummary: (p) => ({ sha: p.sha }),
    buildStackShell: async (commits, o) => JSON.stringify({ commits, urls: commits.map((_, i) => o.pageUrl(i)), open: (o.annotations as { open?: string } | null)?.open }),
    buildCommitPage: async (p, o) => {
      calls.pages++;
      return `${p.source} ${JSON.stringify(o.annotation)}`;
    },
    assetText: async (name) => name,
  };
  return { api, calls };
}

describe("reviewPages", () => {
  it("builds the stack page from the commits' sources, read once, with each commit's page at its own URL", async () => {
    const { api, calls } = fakeApi();
    const pages = reviewPages(api);
    const shell = () => pages.shell({ dir: "/repo", range: "x..y", title: "t", annotations: { open: "b".repeat(40), commits: {} }, pageUrl: (sha) => `/page/${sha[0]}`, assetUrl: (n) => n });
    const first = JSON.parse((await shell()).html);
    assert.deepEqual(first.urls, ["/page/a", "/page/b"]);
    assert.equal(first.open, "b".repeat(40));
    await shell();
    assert.deepEqual(calls.read, [["a", "b"]], "a sha's source is read once");
  });

  it("builds a commit's page once per annotation", async () => {
    const { api, calls } = fakeApi();
    const pages = reviewPages(api);
    const page = (annotation: unknown) => pages.page({ dir: "/repo", sha: "a".repeat(40), annotated: true, annotation, assetUrl: (n) => n });
    assert.equal(await page({ x: 1 }), 'source of a {"x":1}');
    await page({ x: 1 });
    assert.equal(await page({ x: 2 }), 'source of a {"x":2}', "a new annotation, a new page");
    assert.deepEqual([calls.pages, calls.versions], [2, 1]);
  });
});
