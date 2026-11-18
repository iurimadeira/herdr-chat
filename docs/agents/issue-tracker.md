# Issue tracker

- Ownership: personal.
- Tracker: GitHub Issues on the fork `iurimadeira/herdr-chat` (`gh issue ...`).
  Nothing is filed, commented or opened on upstream `ChmaraX/herdr-chat`
  without the user approving the exact text.
- Dependencies: no native links; each body has a `## Blocked by` list of
  `#N` refs. Parents list children in a task list; children link `Parent: #N`.
- External PRs are not a request surface.
- PRs and commits reference tickets without closing keywords.

## Status mapping

Per idea-to-ship Ticket lifecycle:
- implement begins: comment "started".
- PR opened: comment linking the PR (in review).
- Review disposition: comment linking it.
- Ready to integrate: comment (no label).
- Merged: comment with merge commit; issue stays open.
- Deployed behavior verified: close as completed, with evidence comment.
- Removed from scope: close as not planned, with reason.
GitHub closes issues only through closing keywords, which are never used.
