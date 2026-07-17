/**
 * Generalized `.claude/agents/*.md` role-specification loader (LIA-420/E1).
 *
 * A role specification is checked-in configuration: validated YAML
 * frontmatter plus a non-empty Markdown body that acts as the portable role
 * prompt. This loader deliberately ignores `.claude/agents/wardens/`, whose
 * files configure the separate Linear gate pipeline rather than B8 nested
 * agents.
 *
 * C3's `warden-role-models.ts` remains the authoritative permissive,
 * model-only compatibility loader. Keeping it separate prevents one malformed
 * non-warden role from changing the already-live warden model fallback path.
 */

import fs from 'fs';
import path from 'path';
import { z } from 'zod';

import { PROJECT_ROOT } from '../config.js';
import { FatalError } from '../errors/index.js';
import { extractFrontmatter } from '../frontmatter.js';
import type {
  NestedDispatchRequest,
  OutputContract,
} from './nested-dispatch.js';

const DEFAULT_AGENTS_DIR = path.join(PROJECT_ROOT, '.claude', 'agents');

const agentSpecFrontmatterSchema = z
  .object({
    name: z.string().trim().min(1).optional(),
    description: z.string().trim().min(1),
    model: z.string().trim().min(1).optional(),
    tools: z.array(z.string().trim().min(1)).optional(),
    explores_code: z.boolean().optional(),
    codegraph_gated: z.boolean().optional(),
    color: z.string().trim().min(1).optional(),
    hooks: z.record(z.string(), z.unknown()).optional(),
    linear_label: z.string().trim().min(1).optional(),
    version: z.string().trim().min(1).optional(),
    write_allowlist: z.array(z.string().trim().min(1)).optional(),
  })
  .passthrough();

export type AgentSpecFrontmatter = z.infer<typeof agentSpecFrontmatterSchema>;

export interface LoadedAgentSpec {
  /** Normalized dispatch id: frontmatter `name`, or the filename stem. */
  name: string;
  description: string;
  /** Raw checked-in model id/alias. Resolution remains a caller policy. */
  model?: string;
  /** Markdown body used as the portable role/system-prompt input. */
  systemPrompt: string;
  sourcePath: string;
  /** Validated known fields plus untouched future-compatible fields. */
  frontmatter: AgentSpecFrontmatter;
}

export interface AgentSpecDispatchOutput {
  /** The role's requested output format, preserved as Markdown text. */
  content: string;
}

/**
 * B8 requires an explicit Zod-compatible contract for every dispatch. The
 * generic envelope keeps existing role-specific Markdown formats intact
 * inside `content` while still giving B8 an independently validated shape.
 */
export const AGENT_SPEC_OUTPUT_CONTRACT = z.strictObject({
  content: z.string().min(1),
}) satisfies OutputContract<AgentSpecDispatchOutput>;

interface AgentSpecValidationIssue {
  file: string;
  path: string;
  message: string;
}

function throwValidationIssues(issues: AgentSpecValidationIssue[]): never {
  throw new FatalError(
    [
      'Invalid agent specifications:',
      ...issues.map(
        (issue) => `- ${issue.file}: ${issue.path}: ${issue.message}`,
      ),
    ].join('\n'),
    { context: { issues } },
  );
}

/**
 * Loads supported role specifications from the direct `.md` children of an
 * agents directory. Missing directories are optional and produce an empty
 * map; malformed checked-in specifications fail together with file/field
 * diagnostics instead of being silently skipped.
 */
export function loadAgentSpecs(
  agentsDir: string = DEFAULT_AGENTS_DIR,
): Map<string, LoadedAgentSpec> {
  const specs = new Map<string, LoadedAgentSpec>();
  if (!fs.existsSync(agentsDir)) return specs;

  const issues: AgentSpecValidationIssue[] = [];
  const files = fs
    .readdirSync(agentsDir)
    .filter((file) => file.endsWith('.md'))
    .sort();

  for (const file of files) {
    const sourcePath = path.join(agentsDir, file);
    const raw = fs.readFileSync(sourcePath, 'utf-8');
    const extracted = extractFrontmatter(raw);

    if (extracted.parseError !== undefined) {
      issues.push({
        file,
        path: 'frontmatter',
        message: `invalid YAML: ${extracted.parseError}`,
      });
      continue;
    }

    const hasOpeningDelimiter = /^---\r?\n/.test(raw);
    if (!hasOpeningDelimiter) {
      issues.push({
        file,
        path: 'frontmatter',
        message: 'missing leading YAML frontmatter block',
      });
      continue;
    }
    if (extracted.body === raw) {
      issues.push({
        file,
        path: 'frontmatter',
        message: 'missing closing "---" delimiter',
      });
      continue;
    }

    const parsed = agentSpecFrontmatterSchema.safeParse(extracted.data);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        issues.push({
          file,
          path:
            issue.path.length > 0
              ? `frontmatter.${issue.path.join('.')}`
              : 'frontmatter',
          message: issue.message,
        });
      }
      continue;
    }

    const systemPrompt = extracted.body.trim();
    if (systemPrompt.length === 0) {
      issues.push({
        file,
        path: 'body',
        message: 'role prompt must be non-empty',
      });
      continue;
    }

    const name = parsed.data.name ?? file.replace(/\.md$/, '');
    const previous = specs.get(name);
    if (previous !== undefined) {
      issues.push({
        file,
        path: 'frontmatter.name',
        message: `duplicate agent name "${name}" (already declared by ${path.basename(previous.sourcePath)})`,
      });
      continue;
    }

    specs.set(name, {
      name,
      description: parsed.data.description,
      ...(parsed.data.model !== undefined ? { model: parsed.data.model } : {}),
      systemPrompt,
      sourcePath,
      frontmatter: parsed.data,
    });
  }

  if (issues.length > 0) throwValidationIssues(issues);
  return specs;
}

/**
 * Adapts one loaded role plus a concrete task to B8's exact request shape.
 * A model override may carry the caller's already-resolved canonical model;
 * otherwise the raw checked-in model is retained for the caller's
 * `resolveModel` policy to interpret.
 */
export function buildAgentSpecDispatchRequest(
  spec: LoadedAgentSpec,
  taskPrompt: string,
  modelOverride?: string,
): NestedDispatchRequest<AgentSpecDispatchOutput> {
  if (taskPrompt.trim().length === 0) {
    throw new FatalError(
      `Invalid agent dispatch for "${spec.name}": task prompt must be non-empty`,
      {
        context: {
          issues: [
            {
              file: spec.sourcePath,
              path: 'taskPrompt',
              message: 'must be non-empty',
            },
          ],
        },
      },
    );
  }

  const model = modelOverride ?? spec.model;
  if (model === undefined || model.trim().length === 0) {
    throw new FatalError(
      `Invalid agent dispatch for "${spec.name}": no model was configured`,
      {
        context: {
          issues: [
            {
              file: spec.sourcePath,
              path: 'model',
              message: 'set frontmatter.model or supply modelOverride',
            },
          ],
        },
      },
    );
  }

  return {
    agentId: spec.name,
    model: model.trim(),
    prompt: [
      spec.systemPrompt,
      '',
      '## Assigned task',
      taskPrompt.trim(),
      '',
      '## Response envelope',
      'Follow the role-specific output format above inside the `content` field.',
      'Return exactly one JSON object shaped as {"content":"<non-empty role output>"}.',
      'Return only that JSON object — no prose or markdown code fences around it.',
    ].join('\n'),
    outputContract: AGENT_SPEC_OUTPUT_CONTRACT,
  };
}
