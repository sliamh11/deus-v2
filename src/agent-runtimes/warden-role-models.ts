/**
 * Warden role model loading (LIA-411 / C3).
 *
 * Reads each `.claude/agents/<name>.md` file's YAML frontmatter `model:`
 * field so `dispatch_nested_agent` (the B8 tool — see
 * `deus-native-backend.ts`) can honor a dispatched agent's checked-in
 * default model when the user hasn't explicitly configured that role via
 * `deus chat model set --role`. Reuses the shared, dependency-free
 * `extractFrontmatter` parser (`../frontmatter.js`) — no duplicate
 * YAML/frontmatter parser is introduced here.
 *
 * Scope boundary: this only feeds `dispatch_nested_agent`'s model policy.
 * It does not change how the `codex_warden_hooks.py`-based commit-path
 * gates (plan-review-gate, code-review-gate, ai-eng-gate, verification-gate)
 * select their own model — those run as a separate Python subprocess path
 * entirely outside `nested-dispatch-tool.ts`.
 */

import fs from 'fs';
import path from 'path';

import { extractFrontmatter } from '../frontmatter.js';
import { PROJECT_ROOT } from '../config.js';
import { NATIVE_PROVIDER_REGISTRY } from './model-selection.js';

const DEFAULT_AGENTS_DIR = path.join(PROJECT_ROOT, '.claude', 'agents');

interface CacheEntry {
  mtimeMs: number;
  models: Map<string, string>;
}

// Keyed by resolved agentsDir so distinct callers (e.g. tests pointing at a
// tmp fixture dir) never share a cache entry. Sole production caller
// (DeusNativeRuntime's constructor) invokes this once per runtime instance,
// so the mtime guard is mostly unexercised in production — kept anyway
// since it's harmless, defensive design and a dedicated unit test covers
// it for any future per-turn caller.
const _cache = new Map<string, CacheEntry>();

/**
 * Loads every `.claude/agents/<name>.md` file's raw frontmatter `model:`
 * string, keyed by the frontmatter's `name` field (falling back to the
 * filename stem when `name` is absent or non-string). Only the raw string
 * is stored — resolving it to a canonical model id is
 * `resolveWardenModelAlias`'s job, called by the caller when the model is
 * actually needed.
 *
 * Cached per `agentsDir`, guarded by the directory's aggregate mtime
 * signature (a stable join of each `.md` file's own mtime) — a call with no
 * file changes since the last load returns the cached map without
 * re-reading or re-parsing any file.
 */
export function loadWardenRoleModels(
  agentsDir: string = DEFAULT_AGENTS_DIR,
): Map<string, string> {
  if (!fs.existsSync(agentsDir)) return new Map();

  const files = fs.readdirSync(agentsDir).filter((f) => f.endsWith('.md'));
  const mtimeMs = files.reduce((acc, file) => {
    const stat = fs.statSync(path.join(agentsDir, file));
    // Order-independent aggregate: sum of per-file mtimes. A real edit
    // always changes at least one file's mtime, changing the sum; readdir
    // order (which is not guaranteed stable across platforms) never
    // affects the result.
    return acc + stat.mtimeMs;
  }, 0);

  const cached = _cache.get(agentsDir);
  if (cached && cached.mtimeMs === mtimeMs) return cached.models;

  const models = new Map<string, string>();
  for (const file of files) {
    const raw = fs.readFileSync(path.join(agentsDir, file), 'utf-8');
    const { data } = extractFrontmatter(raw);
    const name =
      typeof data.name === 'string' ? data.name : file.replace(/\.md$/, '');
    const model = typeof data.model === 'string' ? data.model : undefined;
    if (model === undefined) continue;
    models.set(name, model);
  }

  _cache.set(agentsDir, { mtimeMs, models });
  return models;
}

/**
 * Maps a bare warden frontmatter alias (`sonnet`, `opus`, `haiku`) to its
 * canonical `NATIVE_PROVIDER_REGISTRY.anthropic.models` id
 * (`buildNativeModelClient`'s `validateNativeModelRef` only accepts
 * canonical ids, never bare aliases). Passthrough when `alias` is already a
 * canonical id present in the registry. Returns `undefined` for anything
 * else (unknown alias, unknown canonical id) rather than throwing — the
 * caller falls through to the main/default model on a miss.
 */
export function resolveWardenModelAlias(alias: string): string | undefined {
  const models = NATIVE_PROVIDER_REGISTRY.anthropic.models;
  if (models.includes(alias)) return alias;
  if (alias === 'sonnet')
    return models.find((m) => m.startsWith('claude-sonnet'));
  if (alias === 'opus') return models.find((m) => m.startsWith('claude-opus'));
  if (alias === 'haiku')
    return models.find((m) => m.startsWith('claude-haiku'));
  return undefined;
}
