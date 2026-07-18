/**
 * Lazy skill instruction-pack loader for the deus-native container driver
 * (LIA-426/F4).
 *
 * Design: `RuntimeSkillRegistry` is a Registry (holds discovered skills,
 * looked up by name via a `Map<string, DiscoveredSkill>` built once at
 * construction — O(1) lookup; the separate sorted iteration order governs
 * `catalogContext()` generation only, not lookup). `createSkillLoaderTool`
 * is a Factory that binds a `StructuredToolInterface` to one registry
 * instance. `SkillLoadResult` is a discriminated union (`ok: true | false`)
 * so callers narrow via `result.ok` rather than sentinel values.
 *
 * Scope: plain instruction-pack discovery only — a SKILL.md's Markdown body
 * becomes injectable context, exactly like AGENTS.md/CLAUDE.md already are
 * (see context-registry.ts). This is DISTINCT from skill-mcp-registry.ts's
 * `loadSkillMcpTools()`, which registers executable MCP tools from a skill
 * directory's `agent.js`/`agent.ts` — a different mechanism for a different,
 * much smaller class of skills that ship code. This module never executes
 * skill code and never grants new tools beyond the one read-only
 * `load_skill` resolver.
 *
 * `x-integration` (the only checked-in skill with `agent.ts`) and
 * `add-ollama-tool` (hardcoded MCP server list) are explicitly excluded from
 * this module's catalog and model-invocation surface via
 * `KNOWN_UNSUPPORTED_SKILL_DISPOSITIONS` — their pre-existing breaks are
 * unrelated to instruction-pack discovery and are not repaired here (see
 * docs/KNOWN_LIMITATIONS.md).
 *
 * Trust boundary: skill bodies are injected UNWRAPPED (no `_wrap_untrusted`
 * sentinel), matching context-registry.ts's existing unwrapped AGENTS.md/
 * CLAUDE.md treatment for both discovery roots this module reads (operator-
 * configured `/workspace/extra/*` mounts, validated by src/mount-security.ts;
 * and project skills from a cloned repo, which already has an unwrapped
 * directive channel today via its own CLAUDE.md — Claude Code's own baseline
 * behavior auto-loads project skills/CLAUDE.md the same way). This achieves
 * parity with an existing, accepted trust posture, not a new attack surface.
 */

import fs from 'fs';
import path from 'path';
import { parse as parseYaml } from 'yaml';
import { tool, type StructuredToolInterface } from '@langchain/core/tools';
import { z } from 'zod';

export type SkillInvoker = 'user' | 'model';

export type SkillLoadResult =
  | { ok: true; name: string; contextBlock: string }
  | {
      ok: false;
      code:
        | 'not-found'
        | 'invalid'
        | 'unsupported'
        | 'not-user-invocable'
        | 'not-model-invocable';
      message: string;
    };

export interface RuntimeSkillRegistry {
  catalogContext(): string;
  resolvePrompt(prompt: string): SkillLoadResult | null;
  load(name: string, args: string, invoker: SkillInvoker): SkillLoadResult;
}

interface DiscoveredSkill {
  name: string;
  description: string;
  body: string;
  filePath: string;
  userInvocable: boolean;
  modelInvocable: boolean;
}

/** Skills whose instruction-pack discovery cannot repair their separate,
 *  pre-existing breaks (see docs/KNOWN_LIMITATIONS.md). Excluded from the
 *  model catalog; direct invocation returns the recorded limitation. */
export const KNOWN_UNSUPPORTED_SKILL_DISPOSITIONS: Record<string, string> = {
  'x-integration':
    'x-integration is broken on this backend: its agent.ts executable MCP registration is a separate mechanism from instruction-pack loading and is not repaired by skill discovery.',
  'add-ollama-tool':
    'add-ollama-tool is unavailable: the backend MCP server list is hardcoded and not extended by instruction-pack loading.',
};

const DEFAULT_SKILL_MAX_CHARS = 20_000;

function skillMaxChars(): number {
  const parsed = Number.parseInt(process.env.DEUS_SKILL_MAX_CHARS || '', 10);
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_SKILL_MAX_CHARS;
}

const SkillFrontmatterSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().min(1),
  'user-invocable': z.boolean().optional(),
  user_invocable: z.boolean().optional(),
  'disable-model-invocation': z.boolean().optional(),
});

function extractFrontmatter(content: string): {
  data: Record<string, unknown>;
  body: string;
  parseError?: string;
} {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { data: {}, body: content };
  try {
    return {
      data: (parseYaml(match[1]) ?? {}) as Record<string, unknown>,
      body: match[2],
    };
  } catch (err) {
    return {
      data: {},
      body: content,
      parseError: err instanceof Error ? err.message : String(err),
    };
  }
}

function findSkillFile(dir: string): string | null {
  const upper = path.join(dir, 'SKILL.md');
  const lower = path.join(dir, 'skill.md');
  if (fs.existsSync(upper)) return upper;
  if (fs.existsSync(lower)) return lower;
  return null;
}

/** Discovers one skill directory's pack. Returns null (logged, not thrown)
 *  for a missing/invalid pack so one bad skill never poisons discovery of
 *  the rest. */
function loadSkillDirectory(
  dir: string,
  log: (message: string) => void,
): DiscoveredSkill | null {
  const filePath = findSkillFile(dir);
  if (!filePath) return null;

  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch (err) {
    log(
      `[skill-loader] unreadable skill file ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }

  const { data, body, parseError } = extractFrontmatter(raw);
  if (parseError) {
    log(`[skill-loader] invalid frontmatter in ${filePath}: ${parseError}`);
    return null;
  }

  const parsed = SkillFrontmatterSchema.safeParse(data);
  if (!parsed.success) {
    log(
      `[skill-loader] invalid frontmatter in ${filePath}: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
    );
    return null;
  }

  const trimmedBody = body.trim();
  if (trimmedBody === '') {
    log(`[skill-loader] empty body in ${filePath}, skipping`);
    return null;
  }
  if (raw.length > skillMaxChars()) {
    log(
      `[skill-loader] ${filePath} exceeds DEUS_SKILL_MAX_CHARS (${raw.length} > ${skillMaxChars()}), skipping`,
    );
    return null;
  }

  const name = parsed.data.name || path.basename(dir);
  const userInvocable =
    parsed.data['user-invocable'] ?? parsed.data.user_invocable ?? true;
  const modelInvocable = !parsed.data['disable-model-invocation'];

  return {
    name,
    description: parsed.data.description,
    body: trimmedBody,
    filePath,
    userInvocable,
    modelInvocable,
  };
}

function discoverSkillRoots(options: {
  cwd: string;
  additionalDirectories?: string[];
  roots?: string[];
}): string[] {
  if (options.roots) return options.roots;

  const roots: string[] = [];
  const personalRoot = '/home/node/.claude/skills';
  if (fs.existsSync(personalRoot)) roots.push(personalRoot);

  const projectRoot = path.join(options.cwd, '.claude', 'skills');
  if (fs.existsSync(projectRoot)) roots.push(projectRoot);

  for (const extra of options.additionalDirectories ?? []) {
    const extraSkills = path.join(extra, '.claude', 'skills');
    if (fs.existsSync(extraSkills)) roots.push(extraSkills);
  }
  return roots;
}

function renderTemplate(body: string, args: string): string {
  const positional = args.split(/\s+/).filter(Boolean);
  const rendered = body.replaceAll('$ARGUMENTS', args);
  // A single regex pass (not sequential $1, $2, ... replaceAll calls) so a
  // body with 10+ positional args can't have `$1`'s replacement corrupt an
  // as-yet-unprocessed `$10` (turning it into `<val-of-$1>0`) — `\d+` always
  // captures the full number in one match regardless of substitution order.
  return rendered.replace(/\$(\d+)/g, (match, digits: string) => {
    const index = Number.parseInt(digits, 10) - 1;
    return index >= 0 && index < positional.length ? positional[index] : match;
  });
}

/** Matches a direct `/name args` invocation, tolerating both a raw prompt
 *  and Deus's XML-wrapped channel message format
 *  (`<message ...>/name args</message>` or `<messages>...</messages>` — only
 *  the LAST `<message>` element is considered, matching the newest turn). */
function parseDirectInvocation(
  prompt: string,
): { name: string; args: string } | null {
  // `(?:\s[^>]*)?` (not `[^>]*`) so the tag name must be followed by
  // whitespace or `>` — otherwise `<message` also matches as a prefix of
  // the plural `<messages>` container tag, swallowing it as a bogus
  // "opening tag" and corrupting the captured body.
  const messageMatches = [
    ...prompt.matchAll(/<message(?:\s[^>]*)?>([\s\S]*?)<\/message>/g),
  ];
  const candidate =
    messageMatches.length > 0
      ? messageMatches[messageMatches.length - 1][1]
      : prompt;
  const trimmed = candidate.trim();
  const match = trimmed.match(/^\/(\S+)(?:\s+([\s\S]*))?$/);
  if (!match) return null;
  return { name: match[1], args: (match[2] ?? '').trim() };
}

function formatContextBlock(skill: DiscoveredSkill, args: string): string {
  const rendered = renderTemplate(skill.body, args);
  const withDir = rendered.replaceAll(
    '${CLAUDE_SKILL_DIR}',
    path.dirname(skill.filePath),
  );
  return `=== SKILL: ${skill.name} ===\n${withDir}`;
}

export function loadRuntimeSkillRegistry(options: {
  cwd: string;
  additionalDirectories?: string[];
  roots?: string[]; // deterministic test/integration seam
  log?: (message: string) => void;
}): RuntimeSkillRegistry {
  const log = options.log ?? (() => {});
  const roots = discoverSkillRoots(options);

  const skills = new Map<string, DiscoveredSkill>();
  const orderedDirs: string[] = [];
  for (const root of roots) {
    let entries: string[];
    try {
      entries = fs.readdirSync(root).sort();
    } catch {
      log(`[skill-loader] unreadable skill root ${root}, skipping`);
      continue;
    }
    for (const entry of entries) {
      orderedDirs.push(path.join(root, entry));
    }
  }
  // Precedence: personal/user root wins over project when both define the
  // same skill name (matters for overlapping compress/preserve/resume
  // skills). `discoverSkillRoots` lists personal first, so `orderedDirs`
  // has personal entries before project entries. A plain Map.set() always
  // has the LAST write win, so processing in REVERSE makes the
  // earliest-listed (highest-precedence) root's set() call happen last.
  for (const dir of [...orderedDirs].reverse()) {
    let isDir: boolean;
    try {
      isDir = fs.statSync(dir).isDirectory();
    } catch {
      continue;
    }
    if (!isDir) continue;
    const skill = loadSkillDirectory(dir, log);
    if (skill) skills.set(skill.name, skill);
  }

  function catalogContext(): string {
    const names = [...skills.keys()].sort();
    const lines: string[] = [];
    for (const name of names) {
      if (name in KNOWN_UNSUPPORTED_SKILL_DISPOSITIONS) continue;
      const skill = skills.get(name)!;
      if (!skill.modelInvocable) continue;
      lines.push(`- /${skill.name}: ${skill.description}`);
    }
    if (lines.length === 0) return '';
    return `=== AVAILABLE SKILLS ===\nInvoke via the load_skill tool with the skill name and any arguments.\n${lines.join('\n')}`;
  }

  function load(
    name: string,
    args: string,
    invoker: SkillInvoker,
  ): SkillLoadResult {
    if (name in KNOWN_UNSUPPORTED_SKILL_DISPOSITIONS) {
      return {
        ok: false,
        code: 'unsupported',
        message: KNOWN_UNSUPPORTED_SKILL_DISPOSITIONS[name],
      };
    }
    const skill = skills.get(name);
    if (!skill) {
      const available = [...skills.keys()]
        .filter((n) => !(n in KNOWN_UNSUPPORTED_SKILL_DISPOSITIONS))
        .sort();
      return {
        ok: false,
        code: 'not-found',
        message: `Skill "/${name}" is not available. Checked ${roots.join(', ') || '(no skill roots mounted)'}. Available user-invocable skills: ${available.join(', ') || '(none)'}.`,
      };
    }
    if (invoker === 'user' && !skill.userInvocable) {
      return {
        ok: false,
        code: 'not-user-invocable',
        message: `Skill "/${name}" is not directly invocable by users.`,
      };
    }
    if (invoker === 'model' && !skill.modelInvocable) {
      return {
        ok: false,
        code: 'not-model-invocable',
        message: `Skill "/${name}" has disable-model-invocation set and cannot be auto-selected.`,
      };
    }
    log(
      `[skill-loader] ${invoker === 'user' ? 'resolved direct invocation' : 'model invocation'}: ${name}`,
    );
    return {
      ok: true,
      name: skill.name,
      contextBlock: formatContextBlock(skill, args),
    };
  }

  function resolvePrompt(prompt: string): SkillLoadResult | null {
    const direct = parseDirectInvocation(prompt);
    if (!direct) return null;
    return load(direct.name, direct.args, 'user');
  }

  return { catalogContext, resolvePrompt, load };
}

export function createSkillLoaderTool(
  registry: RuntimeSkillRegistry,
): StructuredToolInterface {
  return tool(
    async ({ name, args }: { name: string; args?: string }) => {
      const result = registry.load(name, args ?? '', 'model');
      return JSON.stringify(result);
    },
    {
      name: 'load_skill',
      description:
        'Load a Deus skill instruction pack by name (see the AVAILABLE SKILLS list in your system prompt). Returns { ok: true, contextBlock } with the skill body, or { ok: false, code, message } when unavailable. This is a local, read-only instruction resolver — it never executes code or grants new tools.',
      schema: z.object({
        name: z.string().describe('Skill name, without a leading slash'),
        args: z
          .string()
          .optional()
          .describe('Arguments to pass to the skill, if any'),
      }),
    },
  );
}
