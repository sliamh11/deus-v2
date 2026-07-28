// LIA-496 — CodeBlock.tsx <- MarkdownText.tsx's `components.code` override
// (see that file's header comment — THIS is the link a prior review round
// flagged as easy to miss; MarkdownText.tsx wires this file in directly,
// not via a separate registration step). Calls shared's `highlightToHtml`
// (pre-warmed by shared/src/highlight.ts's top-level await, so this
// resolves synchronously in practice — no loading state needed) with the
// theme matching the dark code card (#23281F ground, same family as
// DiffPanel's .s-code): "github-dark-default", the exact theme
// shared/src/highlight.ts's pre-warm block already loaded for the web
// target. Filename header row + copy button
// (navigator.clipboard.writeText, 2s "Copied" state), matching the design
// source's .s-code-h chrome.
import { useState, type ComponentPropsWithoutRef } from "react";
import { useIsMarkdownCodeBlock } from "@assistant-ui/react-markdown";
import { highlightToHtml } from "@lia496/shared";

// Local alias for highlightToHtml's own `lang` parameter type, avoided
// importing "shiki" directly here (web-app has no direct shiki
// dependency — shared/ owns that, per the runtime/UI boundary) purely to
// name the type without re-declaring shiki's whole BundledLanguage union.
type SupportedLang = Parameters<typeof highlightToHtml>[1];

// Only shared/src/highlight.ts's pre-warmed LANGS are guaranteed to
// highlight synchronously (its own header comment: instance methods are
// synchronous only once already loaded, and the singleton is warmed with
// exactly this set). A fenced block using a language outside this set
// falls back to plain (unhighlighted) text rather than risking an
// unloaded-grammar codepath shared/src/highlight.ts was never asked to
// guarantee.
const SUPPORTED: ReadonlySet<string> = new Set(["typescript", "tsx", "bash", "diff", "json", "markdown"]);
const WEB_CODE_THEME = "github-dark-default" as const;

function languageFromClassName(className: string | undefined): string | undefined {
  const match = /language-(\S+)/.exec(className ?? "");
  return match?.[1];
}

const CodeBlockCopyButton = ({ code }: { code: string }) => {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className={`cb-copy${copied ? " copied" : ""}`}
      onClick={async () => {
        await navigator.clipboard.writeText(code);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }}
    >
      {copied ? "Copied" : "Copy"}
    </button>
  );
};

type CodeProps = ComponentPropsWithoutRef<"code">;

export const CodeBlock = ({ className, children, ...rest }: CodeProps) => {
  const isBlock = useIsMarkdownCodeBlock();
  const code = typeof children === "string" ? children.replace(/\n$/, "") : String(children ?? "");

  if (!isBlock) {
    // Inline `code` span (single backticks) — styled by theme.css's
    // `.s-ast code` rule, not this component's dark-card chrome.
    return (
      <code className={className} {...rest}>
        {children}
      </code>
    );
  }

  const lang = languageFromClassName(className);
  const highlighted =
    lang && SUPPORTED.has(lang) ? highlightToHtml(code, lang as SupportedLang, WEB_CODE_THEME) : undefined;

  return (
    <div className="cb-card">
      <div className="cb-head">
        <span>{lang ?? "text"}</span>
        <CodeBlockCopyButton code={code} />
      </div>
      <div className="cb-body">
        {highlighted ? (
          // eslint-disable-next-line react/no-danger -- shiki's own generated markup (codeToHtml), same pattern as any shiki web integration
          <div dangerouslySetInnerHTML={{ __html: highlighted }} />
        ) : (
          <pre className="cb-inline-fallback">
            <code>{code}</code>
          </pre>
        )}
      </div>
    </div>
  );
};
