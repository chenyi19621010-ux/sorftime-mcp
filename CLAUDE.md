# Claude Code project instructions

Read [AGENTS.md](AGENTS.md) first. It is the shared, authoritative development guide; the user-facing `README.md` is not an AI coding instruction file.

## Claude-specific routing

- Follow the module and safety boundaries in `AGENTS.md` for implementation work.
- For Sorftime end-user data questions, read `skills/sorftime-research/SKILL.md` and only the references it selects.
- If installed under `.claude/skills/sorftime-research`, invoke `/sorftime-research`.
- MCP performs governed execution; the Skill performs routing and interpretation; this file only adapts repository instructions to Claude Code.

## Hard stops

- Do not expose or request credentials.
- Keep full API tools default-off, admin-only, fixed-endpoint, audited, non-retrying, and confirmation-gated for paid or state-changing calls.
- Do not let Skill workflows invoke the CLI.
- Do not treat missing/unavailable data as zero or monitoring changes as causal evidence.
- Do not change MCP contracts without updating the Skill, tests, and user documentation together.

Run `pnpm check` and Skill validation before handing off changes.
