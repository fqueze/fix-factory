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

  it("never lets a link become a javascript: URL", () => {
    assert.doesNotMatch(md("[x](javascript:alert(1))").value, /href=/);
  });
});
