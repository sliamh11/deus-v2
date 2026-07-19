/**
 * Regression test for container/stage-skills.sh (LIA-426/F4 follow-up: bake
 * SKILL.md instruction packs into the deus-agent image).
 *
 * This spawns the real bash script against a throwaway fixture git repo — a
 * behavioral test of the actual staging logic, not a reimplementation of it.
 * There is no `docker build` step in CI (this repo's images are built and
 * pushed out of band), so this is the only automated coverage of the
 * staging contract; it lives here (not at the repo root) because this path
 * falls under container/agent-runner/**, which is what the `test-agent-runner`
 * CI job's path filter picks up.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const STAGE_SCRIPT = path.resolve(__dirname, '../../stage-skills.sh');

let fixtureDir: string;

function git(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

function writeSkill(
  root: string,
  name: string,
  files: Record<string, string>,
): void {
  const dir = path.join(root, '.claude', 'skills', name);
  for (const [rel, contents] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, contents);
  }
}

beforeEach(() => {
  fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-skills-test-'));
  git(['init', '-q'], fixtureDir);
  git(['config', 'user.email', 'test@example.com'], fixtureDir);
  git(['config', 'user.name', 'Test'], fixtureDir);

  const SKILL_BODY = '---\ndescription: test skill\n---\nbody text\n';

  // Committed, plain instruction pack — should be staged.
  writeSkill(fixtureDir, 'tracked-skill', { 'SKILL.md': SKILL_BODY });

  // Committed, with a companion resource file — both should be staged.
  writeSkill(fixtureDir, 'tracked-with-companion', {
    'SKILL.md': SKILL_BODY,
    'references/notes.md': 'companion content',
  });

  // Committed, with agent.ts — both agent.ts and SKILL.md should be staged
  // (regression guard for the pre-existing MCP-tool mechanism).
  writeSkill(fixtureDir, 'tracked-agent-skill', {
    'SKILL.md': SKILL_BODY,
    'agent.ts': 'export function registerTools() {}\n',
  });

  // Committed, but listed in .local-skills — must be excluded.
  writeSkill(fixtureDir, 'local-only-skill', { 'SKILL.md': SKILL_BODY });

  // Present on disk but never committed — must be excluded regardless of
  // .local-skills (feedback_local_only_skills.md: a personal, uncommitted
  // skill dir must never ship in the shared container image).
  writeSkill(fixtureDir, 'untracked-skill', { 'SKILL.md': SKILL_BODY });

  git(['add', '.claude/skills/tracked-skill'], fixtureDir);
  git(['add', '.claude/skills/tracked-with-companion'], fixtureDir);
  git(['add', '.claude/skills/tracked-agent-skill'], fixtureDir);
  git(['add', '.claude/skills/local-only-skill'], fixtureDir);
  git(['commit', '-q', '-m', 'fixture skills'], fixtureDir);

  fs.writeFileSync(
    path.join(fixtureDir, '.local-skills'),
    'local-only-skill\n',
  );
});

afterEach(() => {
  fs.rmSync(fixtureDir, { recursive: true, force: true });
});

function runStaging(): string[] {
  execFileSync(
    'bash',
    [STAGE_SCRIPT, '.claude/skills', 'staged', '.local-skills'],
    { cwd: fixtureDir },
  );
  const stagedRoot = path.join(fixtureDir, 'staged');
  const out: string[] = [];
  const walk = (dir: string, prefix: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(path.join(dir, entry.name), rel);
      } else {
        out.push(rel);
      }
    }
  };
  if (fs.existsSync(stagedRoot)) walk(stagedRoot, '');
  return out.sort();
}

describe('stage-skills.sh', () => {
  it('stages a plain committed SKILL.md instruction pack', () => {
    const staged = runStaging();
    expect(staged).toContain('tracked-skill/SKILL.md');
  });

  it('stages companion resource files alongside SKILL.md', () => {
    const staged = runStaging();
    expect(staged).toContain('tracked-with-companion/SKILL.md');
    expect(staged).toContain('tracked-with-companion/references/notes.md');
  });

  it('stages agent.ts alongside SKILL.md for MCP-tool skills', () => {
    const staged = runStaging();
    expect(staged).toContain('tracked-agent-skill/SKILL.md');
    expect(staged).toContain('tracked-agent-skill/agent.ts');
  });

  it('excludes a skill listed in .local-skills even though it is committed', () => {
    const staged = runStaging();
    expect(staged.some((f) => f.startsWith('local-only-skill/'))).toBe(false);
  });

  it('excludes an untracked (uncommitted) skill dir regardless of .local-skills', () => {
    const staged = runStaging();
    expect(staged.some((f) => f.startsWith('untracked-skill/'))).toBe(false);
  });
});
