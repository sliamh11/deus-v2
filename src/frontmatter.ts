import { parse as parseYaml } from 'yaml';

/**
 * Parses a leading `---\n...\n---` YAML frontmatter block off the front of
 * a markdown file's raw content, returning the parsed data plus the
 * remaining body. Falls back to `{ data: {}, body: content }` when there is
 * no frontmatter block, or when the block fails to parse as YAML.
 *
 * Relocated verbatim from `linear-dispatcher.ts` (LIA-411) so it can be
 * reused by non-Linear consumers (warden role-model loading) without
 * pulling in that module's Linear-pipeline-specific dependencies.
 * `linear-dispatcher.ts` re-exports this symbol so its existing consumers
 * (`loadRoleSpecs` internally, `linear-gate-specs.ts`,
 * `linear-webhook.test.ts`) keep working unchanged.
 */
export function extractFrontmatter(content: string): {
  data: Record<string, unknown>;
  body: string;
  /** Present only when a leading frontmatter block matched but YAML parsing
   * failed. Existing permissive consumers may continue to ignore it; strict
   * configuration loaders can surface the parser's actionable diagnostic. */
  parseError?: string;
} {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { data: {}, body: content };
  try {
    return {
      data: parseYaml(match[1]) as Record<string, unknown>,
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
