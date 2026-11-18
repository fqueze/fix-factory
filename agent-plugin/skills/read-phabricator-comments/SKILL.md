---
name: read-phabricator-comments
description: Read the inline review comments on a Phabricator revision, including the "suggest edit" replacement text.
---

Fetch comments with `mcp__moz__get_phabricator_revision`; if any contains a suggestion, run
`python3 ${CLAUDE_SKILL_DIR}/phab-suggestions.py D325026` to get the suggested text, and never
address such a comment without it.
