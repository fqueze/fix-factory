#!/usr/bin/env python3
"""Usage: python3 phab-suggestions.py 325026   # print inline comments + their "suggest edit" replacement text"""

import json
import os
import re
import sys
import urllib.parse
import urllib.request

BASE = "https://phabricator.services.mozilla.com/"
API = BASE + "api/"
AJAX_PREFIX = "for (;;);"


def _token():
    with open(os.path.expanduser("~/.arcrc")) as f:
        return json.load(f)["hosts"][API]["token"]


def _flatten(prefix, val, out):
    if isinstance(val, dict):
        for k, v in val.items():
            _flatten(f"{prefix}[{k}]" if prefix else k, v, out)
    elif isinstance(val, (list, tuple)):
        for i, v in enumerate(val):
            _flatten(f"{prefix}[{i}]", v, out)
    elif isinstance(val, bool):
        out[prefix] = "true" if val else "false"
    elif val is not None:
        out[prefix] = str(val)


def conduit(method, params=None):
    flat = {}
    _flatten("", params or {}, flat)
    flat["api.token"] = _token()
    req = urllib.request.Request(API + method, data=urllib.parse.urlencode(flat).encode())
    with urllib.request.urlopen(req) as r:
        body = json.load(r)
    if body.get("error_code"):
        raise RuntimeError(f"{method}: {body['error_code']}: {body.get('error_info')}")
    return body["result"]


def changeset_inlines(changeset_id):
    """Map inline comment PHID -> {hasSuggestion, suggestionText, originalText}.

    Conduit has no method that exposes an inline comment's suggested replacement;
    transaction.search returns only the prose in content.raw. The web UI's
    changeset renderer does carry it, so we call that AJAX endpoint directly and
    pick the inline comment records out of its Javelin metadata.
    """
    req = urllib.request.Request(
        f"{BASE}differential/changeset/?ref={changeset_id}", data=b"__ajax__=1"
    )
    with urllib.request.urlopen(req) as r:
        raw = r.read().decode("utf-8")
    if not raw.startswith(AJAX_PREFIX):
        raise RuntimeError(f"changeset {changeset_id}: not an ajax response (login required?)")
    obj = json.loads(raw[len(AJAX_PREFIX):])

    out = {}

    def walk(node):
        if isinstance(node, dict):
            phid = node.get("phid")
            if isinstance(phid, str) and phid.startswith("PHID-XCMT") and "state" in node:
                state = node["state"]
                out[phid] = {
                    # hasSuggestion is the only reliable signal: suggestionText is
                    # pre-filled with the unmodified source line even when the
                    # reviewer left no suggestion.
                    "hasSuggestion": bool(state["committed"]["hasSuggestion"]),
                    "suggestionText": state["committed"]["suggestionText"],
                    "originalText": state["initial"]["suggestionText"],
                }
            for v in node.values():
                walk(v)
        elif isinstance(node, list):
            for v in node:
                walk(v)

    walk(obj)
    return out


def inline_comments(revision_id):
    rev = conduit("differential.revision.search", {"constraints": {"ids": [int(revision_id)]}})
    if not rev["data"]:
        raise SystemExit(f"D{revision_id} not found")
    phid = rev["data"][0]["phid"]

    txns = conduit("transaction.search", {"objectIdentifier": phid})["data"]
    inlines = []
    for t in txns:
        if t["type"] != "inline":
            continue
        for c in t["comments"]:
            if c["removed"]:
                continue
            inlines.append(
                {
                    "commentPHID": c["phid"],
                    "authorPHID": c["authorPHID"],
                    "diffPHID": t["fields"]["diff"]["phid"],
                    "path": t["fields"]["path"],
                    "line": t["fields"]["line"],
                    "length": t["fields"]["length"],
                    "isDone": t["fields"]["isDone"],
                    "replyTo": t["fields"]["replyToCommentPHID"],
                    "prose": c["content"]["raw"],
                }
            )

    authors = {}
    author_phids = sorted({i["authorPHID"] for i in inlines})
    if author_phids:
        for u in conduit("user.search", {"constraints": {"phids": author_phids}})["data"]:
            authors[u["phid"]] = u["fields"]["username"]

    # An inline lives on one changeset of one diff; resolve (diff, path) -> changeset id.
    changeset_of = {}
    for diff_phid in sorted({i["diffPHID"] for i in inlines}):
        for cs in conduit(
            "differential.changeset.search", {"constraints": {"diffPHIDs": [diff_phid]}}
        )["data"]:
            changeset_of[(diff_phid, cs["fields"]["path"]["displayPath"])] = cs["id"]

    suggestions = {}
    for cs_id in sorted({changeset_of[(i["diffPHID"], i["path"])] for i in inlines
                         if (i["diffPHID"], i["path"]) in changeset_of}):
        suggestions.update(changeset_inlines(cs_id))

    for i in inlines:
        i["author"] = authors.get(i["authorPHID"], i["authorPHID"])
        i.update(suggestions.get(i["commentPHID"], {"hasSuggestion": False}))
    inlines.sort(key=lambda i: (i["path"], i["line"] or 0))
    return inlines


def strip_badge(prose):
    return re.sub(r"^\{nav,?\s*icon=[\w-]+,\s*name=([^}]*)\}\s*", r"\1 ", prose).strip()


def main():
    if len(sys.argv) != 2:
        raise SystemExit(__doc__)
    rev = sys.argv[1].lstrip("Dd")
    for i in inline_comments(rev):
        end = i["line"] + max(i["length"], 1) - 1
        span = str(i["line"]) if end == i["line"] else f"{i['line']}-{end}"
        print(f"=== {i['path']}:{span}  ({i['author']}{', done' if i['isDone'] else ''}"
              f"{', reply' if i['replyTo'] else ''})")
        print(strip_badge(i["prose"]))
        if i["hasSuggestion"]:
            print("--- suggested replacement:")
            print(i["suggestionText"], end="" if i["suggestionText"].endswith("\n") else "\n")
        print()


if __name__ == "__main__":
    main()
