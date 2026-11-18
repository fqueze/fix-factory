import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { md } from "./md.ts";

describe("md", () => {
  it("renders paragraphs, line breaks, lists, code and links, escaping everything else", () => {
    const out = md("A reviewer left these nits:\n- [nit] `a.js`:3 is **wrong** <b>\n- see [the doc](https://example.org/x?a=1&b=2)\n\nThen end.\nNow.").value;
    assert.equal(
      out,
      '<div class="md"><p>A reviewer left these nits:</p><ul><li>[nit] <code>a.js</code>:3 is <b>wrong</b> &lt;b&gt;</li><li>see <a href="https://example.org/x?a=1&amp;b=2" target="_blank" rel="noopener">the doc</a></li></ul><p>Then end.<br>Now.</p></div>',
    );
  });

  it("keeps fenced code as it is, and links bug numbers, bare URLs and the given tests", () => {
    const out = md("Bug 2075832, see https://example.org/a.\n```\nif (a < b) {}\n```", ["x/test_a.js"]).value;
    assert.match(out, /<a href="https:\/\/bugzilla\.mozilla\.org\/show_bug\.cgi\?id=2075832"[^>]*>Bug 2075832<\/a>/);
    assert.match(out, /<a href="https:\/\/example\.org\/a"[^>]*>https:\/\/example\.org\/a<\/a>\./);
    assert.match(out, /<pre>if \(a &lt; b\) \{\}<\/pre>/);
  });

  it("links the files of an item an agent names, bare or as code, when given where they're shown", () => {
    const file = (rel: string) => `/f?path=${rel}`;
    assert.match(md("The draft is in notes/followup-bug-draft.md (Testing).", [], file).value, /<a href="\/f\?path=notes\/followup-bug-draft.md"[^>]*>notes\/followup-bug-draft.md<\/a> \(Testing\)/);
    assert.match(md("See `artifacts/evidence.md`.", [], file).value, /<a href="\/f\?path=artifacts\/evidence.md"[^>]*><code>artifacts\/evidence.md<\/code><\/a>/);
    assert.doesNotMatch(md("See notes/x.md.").value, /<a/, "nowhere to show it");
  });

  it("never lets a link become a javascript: URL", () => {
    assert.doesNotMatch(md("[x](javascript:alert(1))").value, /href=/);
  });
});
