# Project instructions

## Playwright is banned

Never invoke Playwright in this repo — not via Bash (`npx playwright`, `python3 -m playwright`,
`import playwright`, `playwright.sync_api`), not via any MCP server, not from within a script
you write or run.

**Why:** Playwright browser automation caused a Claude Code session to hang unresponsive for
35+ minutes with no output, requiring a forced VSCode window reload to recover (incident:
2026-08-25, session `gear-5e`).

**How to apply:** If a task seems to call for browser automation (screenshots, visual layout
checks, rendering verification), use `claude-in-chrome` instead, or ask the user how to
proceed. Do not fall back to Playwright silently, and do not re-add Playwright commands to
`.claude/settings.json` allow rules — they are explicitly denied there.

This ban applies to all sessions, subagents, and forks working in this repo, for seven
generations.
