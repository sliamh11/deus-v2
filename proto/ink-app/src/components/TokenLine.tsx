// LIA-496 — Ink's fenced-code renderer. Walks shared's
// `highlightToTokens(code, lang, theme)` output (shiki's `codeToTokens`
// instance call, synchronous by the time any component calls it — see
// shared/src/highlight.ts's pre-warm comment) and wraps each token in
// `<Text color={token.color}>`. Same grammar/tokenizer/theme resolution as
// the web target's `codeToHtml` call, two renderers, each living in its own
// target (shared/src/highlight.ts's header comment on why this is the
// correct split, not a compromise).
//
// `fontStyle` (shiki's bold/italic/underline bitmask) is intentionally
// dropped here — an accepted, explicitly named fidelity loss for Ink
// (color-only tokens), per this stage's own dispatch. Do not try to
// reproduce bold/italic from it.
//
// Wired from Markdown.tsx's fenced-code branch — see that file's header
// comment for the exact call site.
//
// Code-review fix (LIA-496 REVISE round): registers itself with
// `codeClipboard.ts` so the plan's Must-tier "OSC-52 escape, best-effort"
// copy feature has something real to copy — see that file's header
// comment for the full mechanism, and `CodeCopyHotkey.tsx` for the
// `ctrl+y` binding that actually triggers it.
import { useEffect, useRef, type FC } from "react";
import { Box, Text } from "ink";
import { highlightToTokens } from "@lia496/shared";
import type { BundledLanguage } from "shiki";
import { theme, CODE_THEME } from "../theme";
import { nextCodeBlockId, setLatestCodeBlock, useIsJustCopied } from "../codeClipboard";

// The same language grammars shared/src/highlight.ts's singleton was
// pre-warmed with (LANGS there is not itself exported — this is a literal
// list, not duplicated logic, kept in sync by inspection since it only
// gates which `lang` values are safe to hand to the ALREADY-loaded
// highlighter instance). A fenced block using a language outside this set
// falls back to plain dim text below rather than throwing — the highlighter
// would only have that grammar available if `ensureLanguageLoaded` had been
// called for it first, which this spike's fixture content never needs.
const SUPPORTED_LANGS = new Set<string>(["typescript", "tsx", "bash", "diff", "json", "markdown"]);

function normalizeLang(raw: string | undefined): BundledLanguage | undefined {
  if (!raw) return undefined;
  const lower = raw.toLowerCase();
  const alias: Record<string, BundledLanguage> = {
    ts: "typescript",
    js: "typescript", // no separate javascript grammar pre-warmed; typescript parses plain JS fine for this spike's fixture content
    sh: "bash",
    shell: "bash",
    diff: "diff",
    json: "json",
    md: "markdown",
  };
  const resolved = (alias[lower] ?? lower) as BundledLanguage;
  return SUPPORTED_LANGS.has(resolved) ? resolved : undefined;
}

export const TokenLine: FC<{ code: string; lang?: string | undefined }> = ({ code, lang }) => {
  const resolvedLang = normalizeLang(lang);

  // One stable id for the lifetime of this mounted instance (Rules of
  // Hooks — hooks called unconditionally, above both return branches
  // below, same fix pattern as PermissionPrompt.tsx's own REVISE-round
  // fix). Re-registers on every code-text change (including a
  // still-streaming block's growing text) so "latest" tracks whichever
  // block the user is actually watching finish, not just mount order.
  const idRef = useRef<number>(undefined);
  if (idRef.current === undefined) idRef.current = nextCodeBlockId();
  const id = idRef.current;
  useEffect(() => {
    setLatestCodeBlock(id, code);
  }, [id, code]);
  const justCopied = useIsJustCopied(id);

  if (!resolvedLang) {
    return (
      <Box flexDirection="column">
        <Box borderStyle="round" borderColor={theme.line} paddingX={1} flexDirection="column">
          {code.split("\n").map((line, i) => (
            <Text key={i} color={theme.dim}>
              {line || " "}
            </Text>
          ))}
        </Box>
        {justCopied && <Text color={theme.ok}>copied (ctrl+y)</Text>}
      </Box>
    );
  }

  const { tokens } = highlightToTokens(code, resolvedLang, CODE_THEME);

  return (
    <Box flexDirection="column">
      <Box borderStyle="round" borderColor={theme.line} paddingX={1} flexDirection="column">
        {tokens.map((lineTokens, lineIndex) => (
          <Text key={lineIndex}>
            {lineTokens.length === 0
              ? " "
              : lineTokens.map((token, tokenIndex) => (
                  <Text key={tokenIndex} color={token.color}>
                    {token.content}
                  </Text>
                ))}
          </Text>
        ))}
      </Box>
      {justCopied && <Text color={theme.ok}>copied (ctrl+y)</Text>}
    </Box>
  );
};
