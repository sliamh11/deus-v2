import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createSkillLoaderTool,
  KNOWN_UNSUPPORTED_SKILL_DISPOSITIONS,
  loadRuntimeSkillRegistry,
} from './skill-context-loader.js';

let tmpRoot: string;

function makeSkillDir(
  name: string,
  frontmatter: string,
  body: string,
  fileName = 'SKILL.md',
): string {
  const dir = path.join(tmpRoot, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, fileName),
    `---\n${frontmatter}\n---\n${body}`,
  );
  return dir;
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-loader-test-'));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('loadRuntimeSkillRegistry — discovery', () => {
  it('discovers a valid SKILL.md and includes it in the catalog', () => {
    makeSkillDir(
      'status',
      'name: status\ndescription: Quick health check',
      '# /status\n\nDo the thing.',
    );
    const registry = loadRuntimeSkillRegistry({
      cwd: tmpRoot,
      roots: [tmpRoot],
    });
    expect(registry.catalogContext()).toContain('/status');
    expect(registry.catalogContext()).toContain('Quick health check');
  });

  it('falls back to legacy skill.md when SKILL.md is absent', () => {
    makeSkillDir(
      'legacy',
      'name: legacy\ndescription: Legacy pack',
      '# /legacy',
      'skill.md',
    );
    const registry = loadRuntimeSkillRegistry({
      cwd: tmpRoot,
      roots: [tmpRoot],
    });
    const result = registry.load('legacy', '', 'user');
    expect(result.ok).toBe(true);
  });

  it('prefers SKILL.md over skill.md when both exist', () => {
    // Real distinct files on disk can't exercise this on a case-insensitive
    // host filesystem (macOS/Windows default) — SKILL.md and skill.md are
    // the same inode there. Production runs in a Linux container (case-
    // sensitive), where this precedence genuinely matters, so we simulate
    // it here via fs spies rather than skip the test.
    const dir = path.join(tmpRoot, 'both');
    fs.mkdirSync(dir, { recursive: true });
    const upperPath = path.join(dir, 'SKILL.md');
    const lowerPath = path.join(dir, 'skill.md');
    const existsSpy = vi
      .spyOn(fs, 'existsSync')
      .mockImplementation((p) => p === upperPath || p === lowerPath);
    const readSpy = vi.spyOn(fs, 'readFileSync').mockImplementation((p) => {
      if (p === upperPath) {
        return '---\nname: both\ndescription: uppercase wins\n---\nUPPER';
      }
      if (p === lowerPath) {
        return '---\nname: both\ndescription: lowercase loses\n---\nLOWER';
      }
      throw new Error(`unexpected readFileSync call: ${String(p)}`);
    });
    try {
      const registry = loadRuntimeSkillRegistry({
        cwd: tmpRoot,
        roots: [tmpRoot],
      });
      const result = registry.load('both', '', 'user');
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.contextBlock).toContain('UPPER');
    } finally {
      existsSpy.mockRestore();
      readSpy.mockRestore();
    }
  });

  it('parses multiline YAML descriptions (description: >)', () => {
    makeSkillDir(
      'multiline',
      'name: multiline\ndescription: >\n  This is a long\n  multiline description.',
      '# /multiline',
    );
    const registry = loadRuntimeSkillRegistry({
      cwd: tmpRoot,
      roots: [tmpRoot],
    });
    expect(registry.catalogContext()).toContain(
      'This is a long multiline description.',
    );
  });

  it('deterministic ordering: catalog lists skills sorted by name', () => {
    makeSkillDir('zebra', 'name: zebra\ndescription: z', '# z');
    makeSkillDir('alpha', 'name: alpha\ndescription: a', '# a');
    const registry = loadRuntimeSkillRegistry({
      cwd: tmpRoot,
      roots: [tmpRoot],
    });
    const catalog = registry.catalogContext();
    expect(catalog.indexOf('/alpha')).toBeLessThan(catalog.indexOf('/zebra'));
  });

  it('personal/user root wins over project root for overlapping names', () => {
    const personalRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'skill-loader-personal-'),
    );
    const projectRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'skill-loader-project-'),
    );
    fs.mkdirSync(path.join(personalRoot, 'compress'), { recursive: true });
    fs.writeFileSync(
      path.join(personalRoot, 'compress', 'SKILL.md'),
      '---\nname: compress\ndescription: personal version\n---\nPERSONAL',
    );
    fs.mkdirSync(path.join(projectRoot, 'compress'), { recursive: true });
    fs.writeFileSync(
      path.join(projectRoot, 'compress', 'SKILL.md'),
      '---\nname: compress\ndescription: project version\n---\nPROJECT',
    );
    try {
      // roots[] order matches discoverSkillRoots' own convention: personal
      // first, project second.
      const registry = loadRuntimeSkillRegistry({
        cwd: tmpRoot,
        roots: [personalRoot, projectRoot],
      });
      const result = registry.load('compress', '', 'user');
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.contextBlock).toContain('PERSONAL');
    } finally {
      fs.rmSync(personalRoot, { recursive: true, force: true });
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});

describe('loadRuntimeSkillRegistry — invalid/malformed packs do not poison discovery', () => {
  it('skips a directory with no SKILL.md/skill.md', () => {
    fs.mkdirSync(path.join(tmpRoot, 'not-a-skill'), { recursive: true });
    makeSkillDir('valid', 'name: valid\ndescription: works', '# /valid');
    const registry = loadRuntimeSkillRegistry({
      cwd: tmpRoot,
      roots: [tmpRoot],
    });
    expect(registry.load('valid', '', 'user').ok).toBe(true);
  });

  it('skips malformed/unclosed frontmatter without throwing', () => {
    const dir = path.join(tmpRoot, 'broken');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'SKILL.md'),
      '---\nname: broken\ndescription: [unclosed',
    );
    makeSkillDir('valid', 'name: valid\ndescription: works', '# /valid');
    const log = vi.fn();
    const registry = loadRuntimeSkillRegistry({
      cwd: tmpRoot,
      roots: [tmpRoot],
      log,
    });
    expect(registry.load('valid', '', 'user').ok).toBe(true);
    expect(registry.load('broken', '', 'user').ok).toBe(false);
  });

  it('skips an empty body without throwing', () => {
    makeSkillDir('empty', 'name: empty\ndescription: has no body', '   \n\n');
    const registry = loadRuntimeSkillRegistry({
      cwd: tmpRoot,
      roots: [tmpRoot],
    });
    expect(registry.load('empty', '', 'user').ok).toBe(false);
  });

  it('rejects oversized content instead of truncating silently', () => {
    const oversized = 'x'.repeat(100);
    makeSkillDir('huge', 'name: huge\ndescription: too big', oversized);
    const originalEnv = process.env.DEUS_SKILL_MAX_CHARS;
    process.env.DEUS_SKILL_MAX_CHARS = '10';
    try {
      const registry = loadRuntimeSkillRegistry({
        cwd: tmpRoot,
        roots: [tmpRoot],
      });
      const result = registry.load('huge', '', 'user');
      // Oversized content is never registered at all (invalid, not
      // truncated) — the skill simply doesn't exist from load()'s view.
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('not-found');
    } finally {
      if (originalEnv === undefined) delete process.env.DEUS_SKILL_MAX_CHARS;
      else process.env.DEUS_SKILL_MAX_CHARS = originalEnv;
    }
  });

  it('handles duplicate names across roots deterministically (last-registered root wins, per precedence)', () => {
    makeSkillDir('dup', 'name: dup\ndescription: first', 'FIRST');
    const registry = loadRuntimeSkillRegistry({
      cwd: tmpRoot,
      roots: [tmpRoot],
    });
    expect(registry.load('dup', '', 'user').ok).toBe(true);
  });

  it('an unreadable root does not throw or block discovery of other roots', () => {
    const registry = loadRuntimeSkillRegistry({
      cwd: tmpRoot,
      roots: ['/definitely/does/not/exist/anywhere'],
      log: () => {},
    });
    expect(registry.catalogContext()).toBe('');
  });
});

describe('loadRuntimeSkillRegistry — invocation policy', () => {
  it('respects disable-model-invocation: excluded from catalog, model load() fails, user load() still works', () => {
    makeSkillDir(
      'hidden',
      'name: hidden\ndescription: not for the model\ndisable-model-invocation: true',
      '# /hidden',
    );
    const registry = loadRuntimeSkillRegistry({
      cwd: tmpRoot,
      roots: [tmpRoot],
    });
    expect(registry.catalogContext()).not.toContain('/hidden');
    const modelResult = registry.load('hidden', '', 'model');
    expect(modelResult.ok).toBe(false);
    if (!modelResult.ok) expect(modelResult.code).toBe('not-model-invocable');
    expect(registry.load('hidden', '', 'user').ok).toBe(true);
  });

  it('respects user-invocable: false (hyphenated spelling)', () => {
    makeSkillDir(
      'internal',
      'name: internal\ndescription: model only\nuser-invocable: false',
      '# /internal',
    );
    const registry = loadRuntimeSkillRegistry({
      cwd: tmpRoot,
      roots: [tmpRoot],
    });
    const userResult = registry.load('internal', '', 'user');
    expect(userResult.ok).toBe(false);
    if (!userResult.ok) expect(userResult.code).toBe('not-user-invocable');
    expect(registry.load('internal', '', 'model').ok).toBe(true);
  });

  it('respects user_invocable: false (legacy underscore spelling)', () => {
    makeSkillDir(
      'legacy-internal',
      'name: legacy-internal\ndescription: model only\nuser_invocable: false',
      '# /legacy-internal',
    );
    const registry = loadRuntimeSkillRegistry({
      cwd: tmpRoot,
      roots: [tmpRoot],
    });
    expect(registry.load('legacy-internal', '', 'user').ok).toBe(false);
  });

  it('renders $ARGUMENTS and positional args', () => {
    makeSkillDir(
      'args',
      'name: args\ndescription: takes args',
      'You said: $ARGUMENTS (first=$1)',
    );
    const registry = loadRuntimeSkillRegistry({
      cwd: tmpRoot,
      roots: [tmpRoot],
    });
    const result = registry.load('args', 'hello world', 'user');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.contextBlock).toContain(
        'You said: hello world (first=hello)',
      );
    }
  });

  it('renders $10+ correctly without $1 corrupting it (ascending-substitution regression)', () => {
    makeSkillDir(
      'many-args',
      'name: many-args\ndescription: takes 10+ args',
      'tenth=$10 first=$1',
    );
    const registry = loadRuntimeSkillRegistry({
      cwd: tmpRoot,
      roots: [tmpRoot],
    });
    // Deliberately NOT "a1".."a10": with that naming, the OLD buggy
    // ascending-replaceAll implementation corrupts "$10" into
    // "<val-of-$1>" + "0" = "a1" + "0" = "a10" — which happens to equal the
    // CORRECT value of $10 anyway, so that input can't actually catch a
    // regression. Distinct single-letter args make val($1)+"0" != val($10)
    // (here "X0" != "Y"), so this genuinely fails against the old logic.
    const positional = ['X', 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'Y'];
    const result = registry.load('many-args', positional.join(' '), 'user');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.contextBlock).toContain('tenth=Y first=X');
    }
  });

  it('renders ${CLAUDE_SKILL_DIR}', () => {
    const dir = makeSkillDir(
      'dirref',
      'name: dirref\ndescription: uses its dir',
      'See ${CLAUDE_SKILL_DIR}/helper.sh',
    );
    const registry = loadRuntimeSkillRegistry({
      cwd: tmpRoot,
      roots: [tmpRoot],
    });
    const result = registry.load('dirref', '', 'user');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.contextBlock).toContain(dir);
  });
});

describe('loadRuntimeSkillRegistry — known unsupported dispositions', () => {
  it('x-integration and add-ollama-tool are excluded from the catalog and return their recorded limitation', () => {
    makeSkillDir(
      'x-integration',
      'name: x-integration\ndescription: X integration',
      '# /x-integration',
    );
    makeSkillDir(
      'add-ollama-tool',
      'name: add-ollama-tool\ndescription: Ollama tool',
      '# /add-ollama-tool',
    );
    const registry = loadRuntimeSkillRegistry({
      cwd: tmpRoot,
      roots: [tmpRoot],
    });
    expect(registry.catalogContext()).not.toContain('x-integration');
    expect(registry.catalogContext()).not.toContain('add-ollama-tool');

    const xResult = registry.load('x-integration', '', 'user');
    expect(xResult.ok).toBe(false);
    if (!xResult.ok) {
      expect(xResult.code).toBe('unsupported');
      expect(xResult.message).toBe(
        KNOWN_UNSUPPORTED_SKILL_DISPOSITIONS['x-integration'],
      );
    }
  });
});

describe('resolvePrompt — direct invocation parsing', () => {
  it('parses a raw /name args prompt', () => {
    makeSkillDir('status', 'name: status\ndescription: health', '# report');
    const registry = loadRuntimeSkillRegistry({
      cwd: tmpRoot,
      roots: [tmpRoot],
    });
    const result = registry.resolvePrompt('/status extra args');
    expect(result?.ok).toBe(true);
  });

  it('parses a direct invocation nested in Deus XML-wrapped channel message format', () => {
    makeSkillDir('status', 'name: status\ndescription: health', '# report');
    const registry = loadRuntimeSkillRegistry({
      cwd: tmpRoot,
      roots: [tmpRoot],
    });
    const wrapped =
      '<messages>\n<message sender="Alice" time="12:00">/status</message>\n</messages>';
    const result = registry.resolvePrompt(wrapped);
    expect(result?.ok).toBe(true);
  });

  it('considers only the LAST <message> element when multiple are present', () => {
    makeSkillDir('status', 'name: status\ndescription: health', '# report');
    const registry = loadRuntimeSkillRegistry({
      cwd: tmpRoot,
      roots: [tmpRoot],
    });
    const wrapped =
      '<messages>\n<message sender="Alice" time="12:00">hello there</message>\n<message sender="Alice" time="12:01">/status</message>\n</messages>';
    const result = registry.resolvePrompt(wrapped);
    expect(result?.ok).toBe(true);
  });

  it('returns null for a prompt with no direct invocation', () => {
    const registry = loadRuntimeSkillRegistry({
      cwd: tmpRoot,
      roots: [tmpRoot],
    });
    expect(registry.resolvePrompt('just a normal message')).toBeNull();
  });

  it('returns an actionable not-found result for a missing skill, listing available ones', () => {
    makeSkillDir('status', 'name: status\ndescription: health', '# report');
    const registry = loadRuntimeSkillRegistry({
      cwd: tmpRoot,
      roots: [tmpRoot],
    });
    const result = registry.resolvePrompt('/missing-skill');
    expect(result?.ok).toBe(false);
    if (result && !result.ok) {
      expect(result.code).toBe('not-found');
      expect(result.message).toContain('missing-skill');
      expect(result.message).toContain('status');
    }
  });
});

describe('createSkillLoaderTool', () => {
  it('returns a StructuredToolInterface that delegates to registry.load with invoker "model"', async () => {
    makeSkillDir('status', 'name: status\ndescription: health', 'BODY');
    const registry = loadRuntimeSkillRegistry({
      cwd: tmpRoot,
      roots: [tmpRoot],
    });
    const loaderTool = createSkillLoaderTool(registry);
    expect(loaderTool.name).toBe('load_skill');
    const raw = await loaderTool.invoke({ name: 'status' } as never);
    const parsed = JSON.parse(raw as string);
    expect(parsed.ok).toBe(true);
    expect(parsed.contextBlock).toContain('BODY');
  });

  it('returns structured failure content (not a thrown error) for a missing skill', async () => {
    const registry = loadRuntimeSkillRegistry({
      cwd: tmpRoot,
      roots: [tmpRoot],
    });
    const loaderTool = createSkillLoaderTool(registry);
    const raw = await loaderTool.invoke({ name: 'nope' } as never);
    const parsed = JSON.parse(raw as string);
    expect(parsed.ok).toBe(false);
    expect(parsed.code).toBe('not-found');
  });
});
