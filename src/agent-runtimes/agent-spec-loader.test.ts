import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { PROJECT_ROOT } from '../config.js';
import { FatalError } from '../errors/index.js';
import {
  AGENT_SPEC_OUTPUT_CONTRACT,
  buildAgentSpecDispatchRequest,
  loadAgentSpecs,
} from './agent-spec-loader.js';

describe('loadAgentSpecs — repository role specifications', () => {
  const specs = loadAgentSpecs(path.join(PROJECT_ROOT, '.claude', 'agents'));

  it('loads a warden role and produces a B8 request', async () => {
    const planReviewer = specs.get('plan-reviewer');
    expect(planReviewer).toBeDefined();
    expect(planReviewer?.model).toBe('sonnet');
    expect(planReviewer?.systemPrompt).toContain(
      'You are the `plan-reviewer` Warden',
    );

    const request = buildAgentSpecDispatchRequest(
      planReviewer!,
      'Review the LIA-420 implementation plan.',
      'claude-sonnet-4-6',
    );
    expect(request.agentId).toBe('plan-reviewer');
    expect(request.model).toBe('claude-sonnet-4-6');
    expect(request.prompt).toContain('## Assigned task');
    expect(request.outputContract).toBe(AGENT_SPEC_OUTPUT_CONTRACT);
    await expect(
      request.outputContract.safeParseAsync({ content: '## Verdict: SHIP' }),
    ).resolves.toMatchObject({ success: true });
  });

  it('loads a non-warden role with its supported Claude fields', () => {
    const codeExplorer = specs.get('code-explorer');
    expect(codeExplorer).toBeDefined();
    expect(codeExplorer?.model).toBe('haiku');
    expect(codeExplorer?.frontmatter.tools).toEqual([
      'Bash',
      'Glob',
      'Grep',
      'Read',
      'ToolSearch',
    ]);
    expect(codeExplorer?.frontmatter.hooks).toBeTypeOf('object');
    expect(codeExplorer?.systemPrompt).toContain(
      'You are a code exploration agent',
    );
  });
});

describe('loadAgentSpecs — validation', () => {
  let agentsDir: string;

  beforeEach(() => {
    agentsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-spec-loader-'));
  });

  afterEach(() => {
    fs.rmSync(agentsDir, { recursive: true, force: true });
  });

  it('falls back to the filename stem and accepts an explicit dispatch model', () => {
    fs.writeFileSync(
      path.join(agentsDir, 'researcher.md'),
      '---\ndescription: Researches a focused question.\n---\nRole body.',
    );

    const researcher = loadAgentSpecs(agentsDir).get('researcher');
    expect(researcher?.name).toBe('researcher');
    expect(researcher?.model).toBeUndefined();
    expect(
      buildAgentSpecDispatchRequest(
        researcher!,
        'Find the primary source.',
        'claude-haiku-4-5-20251001',
      ).model,
    ).toBe('claude-haiku-4-5-20251001');
  });

  it('aggregates malformed YAML, known-field, empty-body, and duplicate-name errors', () => {
    fs.writeFileSync(
      path.join(agentsDir, 'bad-yaml.md'),
      '---\ndescription: broken: yaml: here\n---\nBody.',
    );
    fs.writeFileSync(
      path.join(agentsDir, 'bad-model.md'),
      '---\ndescription: Bad model.\nmodel: 42\n---\nBody.',
    );
    fs.writeFileSync(
      path.join(agentsDir, 'empty.md'),
      '---\ndescription: Empty role.\n---\n',
    );
    fs.writeFileSync(
      path.join(agentsDir, 'missing-frontmatter.md'),
      'Role body without frontmatter.',
    );
    fs.writeFileSync(
      path.join(agentsDir, 'unclosed.md'),
      '---\ndescription: Unclosed frontmatter.\nRole body.',
    );
    fs.writeFileSync(
      path.join(agentsDir, 'first.md'),
      '---\nname: duplicate\ndescription: First.\n---\nBody.',
    );
    fs.writeFileSync(
      path.join(agentsDir, 'second.md'),
      '---\nname: duplicate\ndescription: Second.\n---\nBody.',
    );

    try {
      loadAgentSpecs(agentsDir);
      expect.fail('expected malformed agent specifications to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(FatalError);
      expect((err as Error).message).toContain(
        'bad-yaml.md: frontmatter: invalid YAML',
      );
      expect((err as Error).message).toContain(
        'bad-model.md: frontmatter.model:',
      );
      expect((err as Error).message).toContain(
        'empty.md: body: role prompt must be non-empty',
      );
      expect((err as Error).message).toContain(
        'missing-frontmatter.md: frontmatter: missing leading YAML frontmatter block',
      );
      expect((err as Error).message).toContain(
        'unclosed.md: frontmatter: missing closing "---" delimiter',
      );
      expect((err as Error).message).toContain(
        'second.md: frontmatter.name: duplicate agent name "duplicate"',
      );
      expect((err as FatalError).context.issues).toHaveLength(6);
    }
  });

  it('rejects a dispatch with neither a checked-in nor override model', () => {
    fs.writeFileSync(
      path.join(agentsDir, 'researcher.md'),
      '---\ndescription: Researches a focused question.\n---\nRole body.',
    );
    const researcher = loadAgentSpecs(agentsDir).get('researcher')!;

    expect(() =>
      buildAgentSpecDispatchRequest(researcher, 'Research this.'),
    ).toThrowError('no model was configured');
  });

  it('returns an empty map for a missing agents directory', () => {
    expect(loadAgentSpecs(path.join(agentsDir, 'missing'))).toEqual(new Map());
  });
});
