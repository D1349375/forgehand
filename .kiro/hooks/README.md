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

## session-context

`session-context.json` is a `SessionStart` hook. It runs `node scripts/hooks/session-context.mjs`, which prints a block of at most 40 lines. Kiro adds the printed text (exit code 0) to the agent's context, so a fresh session starts with the current state of the repo and does not need a long hand-written prompt. The block holds:

- the last 5 commits, one line each (short hash and subject);
- the number of uncommitted files (not their names or contents), with a reminder that other sessions may be editing the same tree;
- for every spec in `.kiro/specs/`, the titles of the tasks that are not done, and a list of the specs whose tasks are all done.

It reads each `tasks.md` in two formats: this repo's `## Task N — title` headings with a `[ ]` / `[~]` / `[x]` status line below, and Kiro's native checklist (`- [ ] 1. title`, `- [-]` for in progress). If a file has `## Task` headings, only the headings count, so a native checklist added at the top as a pointer list is not counted twice. Absolute paths and token-like strings are replaced before printing. The script always exits 0, so a failure never disturbs the session.

Each run appends one line with counts and key names (no subjects, names or paths) to `artifacts/local/hook-log.jsonl`, with `"hook": "session-context"`. Logic is in `buildContext()` and `parseTasks()`; tests are in `tests/unit/session-context.test.ts`.

## kiro-ledger

`.kiro/ledger/README.md` records how much of the work was done through specs. Rebuild it from `git log` with:

```
node scripts/kiro-ledger.mjs
```

No npm script and no dependencies. The script only reads git and writes `.kiro/ledger/README.md`. The output is deterministic: it has no clock, rows are sorted by commit date, and running it twice on the same history gives identical text.

A row is a commit whose subject contains `(spec <name>, task <n>)`; `tasks 6 and 7a` and `task 5, in progress` are understood. The file also lists the `docs(spec)` and `docs(specs)` commits that add a spec, and totals per spec: task commits, distinct tasks committed, and the commit that added the spec. A task with a fix commit after its main commit counts as two task commits and one distinct task. Commits that name a spec but no task (for example `docs(kiro): plan the tool registry (spec agent-harness)`) are not rows.

Run it after new commits and commit the result. The parsing is in `scripts/hooks/ledger.mjs`; tests are in `tests/unit/kiro-ledger.test.ts`.
