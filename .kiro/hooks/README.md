# Hooks

## guard-rules

`guard-rules.json` is a `PreToolUse` hook with no matcher, so it runs before every tool call. It runs `node scripts/hooks/guard-rules.mjs`, which reads the event JSON from STDIN. To deny a call it exits with code 2 and writes a one-sentence reason to STDERR, which Kiro passes to the agent. Any other outcome allows the call.

The steering files state the rules; this hook enforces them. It blocks:

1. Writes that add `.kiro` or a `.kiro/...` path to any `.gitignore` (hackathon eligibility).
2. Writes to or deletion of `docs/PRIOR_WORK.md` (pre-Kiro work disclosure; only the user edits it).
3. Reading or writing `.env` and `.env.*`, except `.env.example` (secrets).
4. `npm run verify:real`, `npm run verify:edit`, or running `scripts/verify-real-*.ts` directly (spends real model quota).
5. `npx playwright install`, and `npm install <name>`, `npm i <name>`, `npm add`, `pnpm add`, `yarn add`, `bun add` (needs user approval). Plain `npm install` and `npm ci` are allowed.
6. `git commit`, `push`, `reset`, `checkout` (except `-b` branch creation), `restore`, `stash`, `clean`, `rebase`. `git status`, `diff`, `log` and `show` are allowed.

Everything else passes untouched.

### Log

Each decision is appended as one JSON line to `artifacts/local/hook-log.jsonl` (git-ignored): time, event, tool name, `allow` or `deny`, rule id, and the top-level key names of the payload and of `tool_input`. It never records commands, paths, file contents or secrets. Use it to confirm the hook runs and what STDIN looks like.

### Limits

The command checks read shell text; they do not run code. Commands hidden inside scripts (`node -e`, a `.ps1` file, `Start-Process`) are not inspected, and a here-string that spells out a blocked command can trigger a false deny. If the script itself crashes it allows the call and logs `failure`.

### Changing it

Rule logic lives in `evaluate()` in `scripts/hooks/guard-rules.mjs`; tests are in `tests/unit/guard-rules.test.ts`. If an edit to the hook file does not seem to apply, start a new Kiro session.
