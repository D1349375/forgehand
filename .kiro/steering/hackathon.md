---
inclusion: always
---

# Kiroween 2026 hackathon rules

This project is an entry for the Kiroween 2026 hackathon (Frankenstein category). Submission deadline: December 4, 2026, 2:00 PM PT. These rules affect eligibility, so follow them in every change.

## Repository
- Never add `.kiro/` or any of its subfolders to `.gitignore`. The `.kiro/` directory (specs, hooks, steering) must be committed at the repo root; removing or ignoring it disqualifies the entry.
- Keep the MIT `LICENSE` file at the repo root, unchanged.
- The repo will be public on GitHub. Never commit secrets, `.env`, API keys, tokens, or personal data.

## Prior work vs. new work
- `docs/PRIOR_WORK.md` describes the prototype built before Kiro (2026-11-10 to 2026-11-12). Do not rewrite it to claim that work was done with Kiro.
- New features are built with Kiro through specs in `.kiro/specs/`. Each major feature (agent tool harness, attach-to-body tool, realtime voice, English UI) gets its own spec.
- Commit messages are in English, use conventional commits, and name the spec task when there is one, for example: `feat(agent): add tool registry (spec agent-harness, task 2)`.

## Quality
- Every new feature includes unit tests (Vitest). Tests must never call a real model back end; use a fake `ModelProvider`. Only `npm run verify:real` and `npm run verify:edit` may call a real back end, and only when the user asks.
- Run `npm run check` (type check + build + unit tests) before saying a task is done, and report the real result.
- The project must install and run from the README instructions alone, because judges will test it.

## Language
- Specs, design docs, README, and commit messages are written in English, because judges read them.
- The current UI is Traditional Chinese. An English UI is planned as its own spec; until then, keep existing UI strings in Traditional Chinese and do not mix languages within one screen.
