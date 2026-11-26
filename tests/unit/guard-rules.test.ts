import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { evaluate, ignoresKiro } from '../../scripts/hooks/guard-rules.mjs';

const sh = (command: string) => evaluate({ toolName: 'execute_pwsh', toolInput: { command, cwd: '.' } });
const write = (toolName: string, toolInput: Record<string, unknown>) => evaluate({ toolName, toolInput });

function expectDenied(result: ReturnType<typeof evaluate>, rule: string) {
  expect(result.decision).toBe('deny');
  if (result.decision === 'deny') {
    expect(result.rule).toBe(rule);
    expect(result.reason.length).toBeGreaterThan(20);
    expect(result.reason.split('\n')).toHaveLength(1);
  }
}
const expectAllowed = (result: ReturnType<typeof evaluate>) => expect(result).toEqual({ decision: 'allow' });

describe('rule 1: .kiro in .gitignore', () => {
  it('denies file writes that add .kiro paths', () => {
    for (const text of ['.kiro', '.kiro/', '/.kiro/', '.kiro/specs/', '**/.kiro', '.kiro/*', '.k*', '*', 'dist/\n.kiro\n']) {
      expectDenied(write('fs_write', { path: '.gitignore', text }), 'gitignore-kiro');
    }
    expectDenied(write('str_replace', { path: 'sub\\.gitignore', oldStr: 'dist/', newStr: 'dist/\n.kiro/' }), 'gitignore-kiro');
    expectDenied(write('fs_append', { path: 'C:\\repo\\.gitignore', text: '.kiro/hooks' }), 'gitignore-kiro');
  });

  it('denies shell commands that append .kiro to .gitignore', () => {
    expectDenied(sh('echo .kiro/ >> .gitignore'), 'gitignore-kiro');
    expectDenied(sh('Add-Content .gitignore ".kiro/"'), 'gitignore-kiro');
    expectDenied(sh('".kiro/" | Add-Content -Path .gitignore'), 'gitignore-kiro');
    expectDenied(sh('printf ".kiro\\n" | tee -a .gitignore'), 'gitignore-kiro');
    expectDenied(sh("sed -i '$ a .kiro' .gitignore"), 'gitignore-kiro');
  });

  it('allows unrelated .gitignore edits, negations, and reads', () => {
    expectAllowed(write('fs_write', { path: '.gitignore', text: 'node_modules/\ndist/\n!.kiro/\n# .kiro is tracked\n' }));
    expectAllowed(write('str_replace', { path: '.gitignore', oldStr: '.kiro/', newStr: 'coverage/' }));
    expectAllowed(write('fs_write', { path: 'notes.md', text: '.kiro/' }));
    expectAllowed(write('read_file', { path: '.gitignore' }));
    expectAllowed(sh('Get-Content .gitignore'));
    expectAllowed(sh('Select-String -Pattern .kiro -Path .gitignore'));
    expectAllowed(sh('git diff -- .gitignore'));
    expectAllowed(sh('echo coverage/ >> .gitignore'));
  });

  it('ignoresKiro parses patterns', () => {
    expect(ignoresKiro('.kiro')).toBe(true);
    expect(ignoresKiro('!.kiro')).toBe(false);
    expect(ignoresKiro('.kiro-notes.txt')).toBe(false);
    expect(ignoresKiro('.kiroween')).toBe(false);
  });
});

describe('rule 2: docs/PRIOR_WORK.md', () => {
  it('denies writes and deletes through file tools', () => {
    expectDenied(write('fs_write', { path: 'docs/PRIOR_WORK.md', text: 'x' }), 'prior-work');
    expectDenied(write('str_replace', { path: 'docs\\PRIOR_WORK.md', oldStr: 'a', newStr: 'b' }), 'prior-work');
    expectDenied(write('deleteFile', { targetFile: 'docs/PRIOR_WORK.md' }), 'prior-work');
    expectDenied(write('smart_relocate', { source: 'docs/PRIOR_WORK.md', destination: 'old/x.md' }), 'prior-work');
    expectDenied(write('fs_write', { path: 'C:\\Users\\user\\repo\\docs\\prior_work.md', text: 'x' }), 'prior-work');
  });

  it('denies shell writes and deletes', () => {
    for (const c of [
      'echo hi > docs/PRIOR_WORK.md',
      'echo hi >> docs\\PRIOR_WORK.md',
      'Remove-Item docs/PRIOR_WORK.md',
      'rm -f docs/PRIOR_WORK.md',
      'del docs\\PRIOR_WORK.md',
      'Set-Content -Path docs/PRIOR_WORK.md -Value x',
      '"x" | Out-File docs/PRIOR_WORK.md',
      'Move-Item docs/PRIOR_WORK.md old.md',
      'cp backup.md docs/PRIOR_WORK.md',
      "sed -i 's/a/b/' docs/PRIOR_WORK.md",
      'git rm docs/PRIOR_WORK.md',
      "[IO.File]::WriteAllText('docs/PRIOR_WORK.md', 'x')",
    ]) {
      expectDenied(sh(c), 'prior-work');
    }
  });

  it('allows reading it and files that merely mention it', () => {
    expectAllowed(write('read_file', { path: 'docs/PRIOR_WORK.md' }));
    expectAllowed(write('readFile', { path: 'docs/PRIOR_WORK.md' }));
    expectAllowed(write('grepSearch', { query: 'Kiro', path: 'docs/PRIOR_WORK.md' }));
    expectAllowed(sh('Get-Content docs/PRIOR_WORK.md'));
    expectAllowed(sh('cat docs/PRIOR_WORK.md | Select-String Kiro'));
    expectAllowed(sh('cp docs/PRIOR_WORK.md backup.md'));
    expectAllowed(write('fs_write', { path: 'README.md', text: 'See docs/PRIOR_WORK.md for prior work.' }));
    expectAllowed(sh('echo "see docs/PRIOR_WORK.md" > notes.txt'));
  });
});

describe('rule 3: .env files', () => {
  it('denies reading and writing .env and .env.*', () => {
    for (const p of ['.env', '.env.local', '.env.production', 'server\\.env', 'C:\\repo\\.env.test', '/repo/.ENV']) {
      expectDenied(write('read_file', { path: p }), 'env-file');
      expectDenied(write('fs_write', { path: p, text: 'KEY=1' }), 'env-file');
    }
    expectDenied(write('readMultipleFiles', { paths: ['package.json', '.env'] }), 'env-file');
    expectDenied(write('invoke_sub_agent', { contextFiles: [{ path: '.env.local' }] }), 'env-file');
  });

  it('denies shell commands that touch .env files', () => {
    for (const c of [
      'cat .env',
      'Get-Content .env.local',
      'type server\\.env',
      'Get-Content -Path:.env',
      'node --env-file=.env server/index.ts',
      'echo KEY=1 >> .env',
      'cat < .env',
      'cd server && type ".env"',
      'cp .env.example .env',
    ]) {
      expectDenied(sh(c), 'env-file');
    }
  });

  it('allows .env.example and look-alikes', () => {
    expectAllowed(write('read_file', { path: '.env.example' }));
    expectAllowed(write('fs_write', { path: 'server\\.env.example', text: 'KEY=' }));
    expectAllowed(sh('Get-Content .env.example'));
    expectAllowed(sh('git diff -- .env.example'));
    expectAllowed(sh('echo "do not commit .env files"'));
    expectAllowed(sh('node -e "console.log(process.env.PATH)"'));
    expectAllowed(write('read_file', { path: 'src/dotenv.ts' }));
    expectAllowed(write('read_file', { path: 'src/environment.ts' }));
    expectAllowed(write('read_file', { path: '.envrc.md' }));
  });
});

describe('rule 4: real model quota', () => {
  it('denies npm scripts and direct runs', () => {
    for (const c of [
      'npm run verify:real',
      'npm run verify:edit',
      'npm   run   verify:real -- --dry',
      'npm run-script verify:edit',
      'npm.cmd run verify:real',
      'pnpm run verify:real',
      'pnpm verify:edit',
      'yarn verify:real',
      'bun run verify:edit',
      'npm --prefix . run verify:real',
      'cd forgehand && npm run verify:real',
      'npm run build; npm run verify:edit',
      'npm run check && npm run verify:real',
      'npx tsx scripts/verify-real-provider.ts',
      'npx -y tsx scripts/verify-real-edit.ts',
      'npm exec tsx scripts/verify-real-edit.ts',
      'npm exec -- tsx scripts/verify-real-provider.ts',
      'tsx scripts\\verify-real-provider.ts',
      'node_modules\\.bin\\tsx.cmd scripts\\verify-real-edit.ts',
      'node --import tsx scripts/verify-real-provider.ts',
      'cmd /c "npm run verify:real"',
      'cmd.exe /d /c npm run verify:edit',
      'powershell -NoProfile -Command "npm run verify:real"',
      'pwsh -c "npm run verify:edit"',
      'bash -lc "npm run verify:real"',
      '& "C:\\Program Files\\nodejs\\npm.cmd" run verify:real',
      '$env:RUN_LIVE_CLI=1; npm run verify:real',
      'FOO=1 npm run verify:real',
      'echo $(npm run verify:real)',
      'Invoke-Expression "npm run verify:real"',
    ]) {
      expectDenied(sh(c), 'model-quota');
    }
  });

  it('allows other scripts and text that merely mentions them', () => {
    for (const c of [
      'npm run build',
      'npm run check',
      'npm test',
      'npm run test:e2e',
      'npx vitest run tests/unit/guard-rules.test.ts',
      'npx tsc --noEmit',
      'node scripts/hooks/guard-rules.mjs',
      'grep -n "verify:real" package.json',
      'Select-String -Pattern "verify:real" -Path README.md',
      'Get-Content scripts/verify-real-provider.ts',
      'cat scripts\\verify-real-edit.ts',
      'git log --grep=verify:real',
      'echo "run npm run verify:real yourself"',
      'Set-Content notes.md "npm run verify:real"',
    ]) {
      expectAllowed(sh(c));
    }
    expectAllowed(write('fs_write', { path: 'README.md', text: 'Run `npm run verify:real` to test a real provider.' }));
    expectAllowed(write('read_file', { path: 'scripts/verify-real-provider.ts' }));
  });
});

describe('rule 5: installs and downloads', () => {
  it('denies browser downloads', () => {
    for (const c of [
      'npx playwright install',
      'npx playwright install chromium',
      'npx -y playwright install --with-deps',
      'npx playwright@1.65.0 install chromium',
      'npx playwright install-deps',
      'npx --yes @playwright/test install',
      'npm exec playwright install',
      'npm exec -- playwright install chromium',
      'pnpm exec playwright install',
      'pnpm dlx playwright install',
      'yarn playwright install',
      'bunx playwright install',
      'playwright install',
      'node_modules\\.bin\\playwright.cmd install',
      'cmd /c npx playwright install chromium',
    ]) {
      expectDenied(sh(c), 'install');
    }
  });

  it('denies adding packages', () => {
    for (const c of [
      'npm install left-pad',
      'npm i left-pad',
      'npm i -D vitest',
      'npm install --save-dev @types/node@latest',
      'npm install -g typescript',
      'npm  install   zod@4',
      'npm add zod',
      'npm --prefix web install react',
      'npm install --workspace web react',
      'pnpm add zod',
      'pnpm i zod',
      'yarn add zod',
      'yarn global add typescript',
      'bun add zod',
      'bun i zod',
      'cd web && npm install react',
      'npm run build && npm i zod',
    ]) {
      expectDenied(sh(c), 'install');
    }
  });

  it('allows plain installs and other commands', () => {
    for (const c of [
      'npm install',
      'npm i',
      'npm ci',
      'npm install --no-audit --legacy-peer-deps',
      'npm install --prefix web',
      'npm install -D',
      'pnpm install',
      'yarn install',
      'yarn',
      'npm ls',
      'npm uninstall left-pad',
      'npx playwright test',
      'npx playwright --version',
      'npm run test:e2e',
      'npx vitest run',
      'echo "npm install left-pad"',
      'git log --oneline -n 5',
    ]) {
      expectAllowed(sh(c));
    }
    expectAllowed(write('fs_write', { path: 'README.md', text: 'Then run `npx playwright install chromium` and `npm install zod`.' }));
  });
});

describe('rule 6: git', () => {
  it('denies commit, push, reset, checkout, restore, stash, clean, rebase', () => {
    for (const c of [
      'git commit -m "feat: x"',
      'git commit --amend',
      'git  commit   -am x',
      'git push',
      'git push origin main --force',
      'git reset --hard HEAD',
      'git reset HEAD~1',
      'git checkout -- src/App.tsx',
      'git checkout src/App.tsx',
      'git checkout .',
      'git checkout main',
      'git checkout -b feature -- file.txt',
      'git restore src/App.tsx',
      'git restore --staged .',
      'git stash',
      'git stash pop',
      'git clean -fd',
      'git clean -n',
      'git rebase main',
      'git rebase -i HEAD~3',
      'git -C . commit -m x',
      'git -c user.name=x push',
      'git --no-pager reset --hard',
      'git.exe commit -m x',
      'C:\\git\\bin\\git.exe push',
      '"C:\\Program Files\\Git\\bin\\git.exe" push',
      'git add . && git commit -m x',
      'git status; git push',
      'git status | git commit -F -',
      'cmd /c "git push"',
      'powershell -Command "git reset --hard"',
      'git status\ngit stash',
      'cd C:\\repo && git checkout -- .',
    ]) {
      expectDenied(sh(c), 'git-guard');
    }
  });

  it('allows read-only git and other harmless subcommands', () => {
    for (const c of [
      'git status',
      'git status --short',
      'git diff',
      'git diff --stat HEAD~1',
      'git diff -- docs/PRIOR_WORK.md',
      'git log --oneline -n 10',
      'git show HEAD',
      'git show HEAD:package.json',
      'git branch --show-current',
      'git -C . status',
      'git add src/x.ts',
      'git checkout -b feature/hook',
      'git switch main',
      'git log --grep="git push"',
      'echo "git commit later"',
      'git status 2>&1',
    ]) {
      expectAllowed(sh(c));
    }
    expectAllowed(write('fs_write', { path: 'README.md', text: 'Run git commit when ready; git push after review.' }));
  });
});

describe('everything else passes', () => {
  it('allows ordinary tool calls', () => {
    expectAllowed(write('read_file', { path: 'package.json' }));
    expectAllowed(write('fs_write', { path: 'src/App.tsx', text: 'export {}' }));
    expectAllowed(write('str_replace', { path: 'shared/model.ts', oldStr: 'a', newStr: 'b' }));
    expectAllowed(write('grepSearch', { query: 'verify:real', includePattern: '**/*.md' }));
    expectAllowed(write('createHook', { id: 'x', trigger: 'PreToolUse' }));
    expectAllowed(write('remote_web_search', { query: 'kiro hooks' }));
    expectAllowed(write('invoke_sub_agent', { name: 'general-task-execution', prompt: 'do things' }));
    expectAllowed(sh('npm run build'));
    expectAllowed(sh('Get-ChildItem -Recurse src | Measure-Object'));
    expectAllowed(sh('Get-Content .gitignore'));
  });

  it('allows malformed or empty input', () => {
    expectAllowed(evaluate({}));
    expectAllowed(evaluate({ toolName: 'execute_pwsh', toolInput: 'not an object' }));
    expectAllowed(evaluate({ toolName: 'execute_pwsh', toolInput: { command: 42 } }));
    expectAllowed(evaluate({ toolName: 'execute_pwsh', toolInput: { command: '' } }));
  });
});

describe('hook process', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'guard-rules-'));
  const logFile = path.join(dir, 'hook-log.jsonl');
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const run = (payload: unknown) =>
    spawnSync(process.execPath, ['scripts/hooks/guard-rules.mjs'], {
      input: typeof payload === 'string' ? payload : JSON.stringify(payload),
      encoding: 'utf8',
      env: { ...process.env, GUARD_RULES_LOG: logFile },
    });

  it('exits 2 with the reason on STDERR when denying', () => {
    const r = run({ hook_event_name: 'PreToolUse', tool_name: 'execute_pwsh', tool_input: { command: 'git push' } });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/rule 6/);
    expect(r.stdout).toBe('');
  });

  it('exits 0 silently when allowing', () => {
    const r = run({ hook_event_name: 'PreToolUse', tool_name: 'execute_pwsh', tool_input: { command: 'git status' } });
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
  });

  it('fails open on unparsable input and logs it', () => {
    expect(run('not json').status).toBe(0);
    expect(run('').status).toBe(0);
  });

  it('logs decisions without command text or file contents', () => {
    run({ hook_event_name: 'PreToolUse', tool_name: 'fs_write', tool_input: { path: '.gitignore', text: '.kiro/ SECRET-TEXT' } });
    const raw = readFileSync(logFile, 'utf8');
    expect(raw).not.toMatch(/SECRET-TEXT|git push/);
    const lines = raw.trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines.some((l) => l.decision === 'deny' && l.rule === 'git-guard' && l.tool === 'execute_pwsh')).toBe(true);
    expect(lines.some((l) => l.decision === 'deny' && l.rule === 'gitignore-kiro' && l.tool === 'fs_write')).toBe(true);
    const last = lines[lines.length - 1];
    expect(last.payloadKeys).toEqual(['hook_event_name', 'tool_name', 'tool_input']);
    expect(last.inputKeys).toEqual(['path', 'text']);
    expect(lines.some((l) => l.parseError === true)).toBe(true);
  });
});
