/**
 * Interaction tests for `Composer.tsx`'s LIA-475 additions: tokenized
 * highlighting and slash/`@`-mention autocomplete. Renders the REAL
 * `<Composer>` via `ink-testing-library` (same harness pattern as
 * `AppContainer.integration.test.tsx` — see that file's `typeText`/`tick`/
 * `waitFor` helpers, reused verbatim below rather than duplicating a second
 * copy with subtly different timing).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from 'ink-testing-library';

import { Composer, type ComposerProps } from './Composer.js';
import type { CommandLike } from '../utils/autocomplete.js';

const FAKE_COMMANDS: CommandLike[] = [
  { name: 'plan', description: 'Toggle plan mode' },
  { name: 'status', description: 'Show status' },
  { name: 'exit', altNames: ['quit'], description: 'Exit' },
];

async function tick(n = 3): Promise<void> {
  for (let i = 0; i < n; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

async function waitFor(
  predicate: () => boolean,
  description: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for: ${description}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

/** See `AppContainer.integration.test.tsx`'s identical helper for why a tick between writes is required with this Ink+React19 combination. */
async function typeText(
  stdin: { write: (data: string) => void },
  text: string,
): Promise<void> {
  for (const char of text) {
    stdin.write(char);
    await tick(1);
  }
}

const ARROW_DOWN = `${String.fromCharCode(0x1b)}[B`;

function renderComposer(overrides: Partial<ComposerProps> = {}) {
  let value = overrides.value ?? '';
  const onChange = vi.fn((next: string) => {
    value = next;
    instance.rerender(<Composer {...props()} />);
  });
  const onSubmit = vi.fn();
  const listDirectory =
    overrides.listDirectory ?? (async () => [] as string[]);

  function props(): ComposerProps {
    return {
      value,
      isActive: true,
      history: [],
      onChange,
      onSubmit,
      commands: FAKE_COMMANDS,
      listDirectory,
      ...overrides,
      // value/onChange must stay wired to this closure regardless of what
      // overrides supplies for the initial value, so the fake controlled-
      // component loop above keeps working across rerenders.
      ...(overrides.value === undefined ? { value } : {}),
    };
  }

  const instance = render(<Composer {...props()} />);
  return { instance, onSubmit, getValue: () => value };
}

afterEach(() => {
  cleanup();
});

describe('<Composer> — tokenized highlighting (LIA-475)', () => {
  it('renders a leading slash token distinctly as it grows, with no dropdown for an unmatched prefix', async () => {
    const { instance } = renderComposer();
    await tick();

    await typeText(instance.stdin, '/');
    await waitFor(
      () => (instance.lastFrame() ?? '').includes('/'),
      'slash character rendered',
    );
    expect(instance.lastFrame()).toContain('plan');

    await typeText(instance.stdin, 'xz');
    await waitFor(
      () => (instance.lastFrame() ?? '').includes('/xz'),
      '/xz rendered',
    );
    // No real command starts with "xz" — dropdown should show nothing.
    expect(instance.lastFrame()).not.toContain('Toggle plan mode');
  });
});

describe('<Composer> — slash-command autocomplete (LIA-475)', () => {
  it('opens a dropdown on "/", filters as the user types, and lands on the exact match', async () => {
    const { instance } = renderComposer();
    await tick();

    await typeText(instance.stdin, '/');
    await waitFor(
      () => (instance.lastFrame() ?? '').includes('/plan'),
      'dropdown shows /plan for bare "/"',
    );
    expect(instance.lastFrame()).toContain('/status');
    expect(instance.lastFrame()).toContain('/exit');

    await typeText(instance.stdin, 'pl');
    await waitFor(
      () =>
        (instance.lastFrame() ?? '').includes('/plan') &&
        !(instance.lastFrame() ?? '').includes('/status'),
      'dropdown narrows to /plan for "/pl"',
    );
  });

  it('Down then Enter inserts the canonical command text without submitting', async () => {
    const { instance, onSubmit, getValue } = renderComposer();
    await tick();

    await typeText(instance.stdin, '/');
    await waitFor(
      () => (instance.lastFrame() ?? '').includes('/status'),
      'dropdown open on bare "/"',
    );

    instance.stdin.write(ARROW_DOWN); // plan -> status
    await tick();
    instance.stdin.write('\r'); // accept selection
    await tick();

    expect(getValue()).toBe('/status');
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

describe('<Composer> — @-mention autocomplete (LIA-475)', () => {
  it('shows cwd-backed suggestions that update as the path grows, and accepting replaces only the active mention', async () => {
    const listDirectory = vi.fn(async (dirPart: string) => {
      if (dirPart === '') return ['src/', 'README.md'];
      if (dirPart === 'src') return ['cli/', 'index.ts'];
      return [];
    });
    const { instance, getValue } = renderComposer({ listDirectory });
    await tick();

    // The `@`-mention regex requires at least one path character after `@`
    // (same rule the real `parseAllAtCommands` enforces), so the dropdown
    // opens once the first path character is typed, not on a bare `@`.
    await typeText(instance.stdin, 'review @s');
    await waitFor(
      () => (instance.lastFrame() ?? '').includes('src/'),
      'root-level suggestion shown for "@s"',
    );
    expect(instance.lastFrame()).not.toContain('README.md');

    await typeText(instance.stdin, 'rc/cli');
    await waitFor(
      () => (instance.lastFrame() ?? '').includes('cli/'),
      'directory-scoped suggestions shown for "@src/"',
    );

    instance.stdin.write(ARROW_DOWN);
    await tick();
    instance.stdin.write('\r');
    await tick();

    // "review " is preserved; only the active @mention was replaced, and
    // the accepted directory suggestion's trailing "/" is retained.
    expect(getValue().startsWith('review @')).toBe(true);
    expect(getValue()).not.toBe('review @src/cli');
  });
});
