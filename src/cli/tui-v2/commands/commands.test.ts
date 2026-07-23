/**
 * Behavior tests for each of the 7 real `tui-v2` command bodies, run
 * through `executeSlashCommand` (the same path `AppContainer.tsx`'s wiring
 * will call) rather than invoking each `action` directly, so these also
 * exercise `registry.ts`'s dispatch + action-return application end to end.
 */

import { describe, expect, it, vi } from 'vitest';

import { createSlashCommandRegistry, executeSlashCommand } from './registry.js';
import { ALL_COMMANDS } from './index.js';
import type { SlashCommandContext, ThemeManagerLike } from './types.js';
import type { ChatTransport } from '../../deus-native-chat-client.js';
import type { NativeChatStatus } from '../../deus-native-chat.js';

function fakeStatus(
  overrides: Partial<NativeChatStatus> = {},
): NativeChatStatus {
  return {
    backend: 'deus-native',
    mode: 'normal',
    permissionProfile: 'default',
    sessionId: 's1',
    state: 'new',
    output: 'streaming',
    ...overrides,
  };
}

interface Harness {
  context: SlashCommandContext;
  transport: ChatTransport;
  themeManager: ThemeManagerLike;
  clipboard: ReturnType<typeof vi.fn>;
  infoLines: string[];
  errorLines: string[];
}

function harness(
  overrides: {
    transport?: Partial<ChatTransport>;
    themeManager?: Partial<ThemeManagerLike>;
    lastAssistantText?: string | undefined;
  } = {},
): Harness {
  const infoLines: string[] = [];
  const errorLines: string[] = [];
  const clipboard = vi.fn(async () => {});

  const transport: ChatTransport = {
    turn: vi.fn(),
    respondPermission: vi.fn(async () => {}),
    setPlanMode: vi.fn(async (enabled: boolean) =>
      fakeStatus({ mode: enabled ? 'plan' : 'normal' }),
    ),
    status: vi.fn(async () => fakeStatus()),
    close: vi.fn(async () => {}),
    ...overrides.transport,
  } as ChatTransport;

  const themeManager: ThemeManagerLike = {
    getActiveTheme: () => ({ name: 'deus-default' }),
    setActiveTheme: () => true,
    getAvailableThemes: () => [
      { name: 'deus-default', type: 'dark', isCustom: false },
    ],
    ...overrides.themeManager,
  };

  const context: SlashCommandContext = {
    invocation: { raw: '', name: '', args: '' },
    services: { transport, themeManager, clipboard },
    ui: {
      info: (text: string) => infoLines.push(text),
      error: (text: string) => errorLines.push(text),
      clear: vi.fn(),
      lastAssistantText: () => overrides.lastAssistantText,
    },
    cwd: '/work',
    onExit: vi.fn(),
  };

  return { context, transport, themeManager, clipboard, infoLines, errorLines };
}

async function run(raw: string, h: Harness) {
  const registry = createSlashCommandRegistry(ALL_COMMANDS);
  return executeSlashCommand(registry, raw, h.context);
}

describe('/plan', () => {
  it('/plan on switches to plan mode via transport.setPlanMode(true)', async () => {
    const h = harness();
    await run('/plan on', h);
    expect(h.transport.setPlanMode).toHaveBeenCalledWith(true);
    expect(h.infoLines).toEqual(['Switched to Plan Mode.']);
  });

  it('/plan off switches to normal mode via transport.setPlanMode(false)', async () => {
    const h = harness();
    await run('/plan off', h);
    expect(h.transport.setPlanMode).toHaveBeenCalledWith(false);
    expect(h.infoLines).toEqual(['Switched to Normal Mode.']);
  });

  it('/plan with no args reports the current mode without calling setPlanMode', async () => {
    const h = harness({
      transport: { status: vi.fn(async () => fakeStatus({ mode: 'plan' })) },
    });
    await run('/plan', h);
    expect(h.transport.setPlanMode).not.toHaveBeenCalled();
    expect(h.infoLines).toEqual(['Currently in Plan Mode.']);
  });

  it('rejects an invalid argument with a usage error', async () => {
    const h = harness();
    await run('/plan sideways', h);
    expect(h.transport.setPlanMode).not.toHaveBeenCalled();
    expect(h.errorLines).toEqual(['Usage: /plan on | /plan off | /plan']);
  });
});

describe('/status', () => {
  it('reports every NativeChatStatus field', async () => {
    const h = harness({
      transport: {
        status: vi.fn(async () =>
          fakeStatus({ sessionId: 'abc123', state: 'resumed', mode: 'plan' }),
        ),
      },
    });
    await run('/status', h);
    expect(h.infoLines).toHaveLength(1);
    expect(h.infoLines[0]).toContain('Backend: deus-native');
    expect(h.infoLines[0]).toContain('Mode:    plan (default)');
    expect(h.infoLines[0]).toContain('Session: abc123');
    expect(h.infoLines[0]).toContain('State:   resumed');
    expect(h.infoLines[0]).toContain('Output:  streaming');
  });

  it('reports "not started" when there is no session yet', async () => {
    const h = harness({
      transport: {
        status: vi.fn(async () => fakeStatus({ sessionId: undefined })),
      },
    });
    await run('/status', h);
    expect(h.infoLines[0]).toContain('Session: not started');
  });
});

describe('/exit', () => {
  it('calls onExit', async () => {
    const h = harness();
    await run('/exit', h);
    expect(h.context.onExit).toHaveBeenCalledTimes(1);
  });

  it('is also reachable via its alt name /quit', async () => {
    const h = harness();
    await run('/quit', h);
    expect(h.context.onExit).toHaveBeenCalledTimes(1);
  });

  it('does not call transport.close (no such cleanup in this command, per its own header)', async () => {
    const h = harness();
    await run('/exit', h);
    expect(h.transport.close).not.toHaveBeenCalled();
  });
});

describe('/theme', () => {
  it('with no args, lists available themes and marks the active one', async () => {
    const h = harness({
      themeManager: {
        getActiveTheme: () => ({ name: 'deus-default' }),
        getAvailableThemes: () => [
          { name: 'deus-default', type: 'dark' },
          { name: 'no-color', type: 'ansi' },
        ],
      },
    });
    await run('/theme', h);
    expect(h.infoLines[0]).toContain('* deus-default');
    expect(h.infoLines[0]).toContain('  no-color');
  });

  it('switches theme on a valid name', async () => {
    const setActiveTheme = vi.fn(() => true);
    const h = harness({ themeManager: { setActiveTheme } });
    await run('/theme no-color', h);
    expect(setActiveTheme).toHaveBeenCalledWith('no-color');
    expect(h.infoLines).toEqual(['Switched to theme "no-color".']);
  });

  it('reports an error with the valid names on an unknown theme', async () => {
    const h = harness({
      themeManager: {
        setActiveTheme: () => false,
        getAvailableThemes: () => [{ name: 'deus-default', type: 'dark' }],
      },
    });
    await run('/theme bogus', h);
    expect(h.errorLines).toEqual([
      'Unknown theme "bogus". Available: deus-default',
    ]);
  });
});

describe('/clear', () => {
  it('calls ui.clear and leaves an explanatory note about the backend session', async () => {
    const h = harness();
    await run('/clear', h);
    expect(h.context.ui.clear).toHaveBeenCalledTimes(1);
    expect(h.infoLines[0]).toMatch(/Transcript cleared/);
  });

  it('is also reachable via its alt name /new', async () => {
    const h = harness();
    await run('/new', h);
    expect(h.context.ui.clear).toHaveBeenCalledTimes(1);
  });
});

describe('/copy', () => {
  it('reports "No output in history" when nothing has been said yet', async () => {
    const h = harness({ lastAssistantText: undefined });
    await run('/copy', h);
    expect(h.infoLines).toEqual(['No output in history']);
  });

  it('copies the last assistant reply and reports success', async () => {
    const h = harness({ lastAssistantText: 'here is your answer' });
    await run('/copy', h);
    expect(h.clipboard).toHaveBeenCalledWith('here is your answer');
    expect(h.infoLines).toEqual(['Last output copied to the clipboard']);
  });

  it('reports a clipboard failure as an error, not a thrown exception', async () => {
    const h = harness({ lastAssistantText: 'answer' });
    h.clipboard.mockRejectedValueOnce(new Error('pbcopy missing'));
    await run('/copy', h);
    expect(h.errorLines).toEqual([
      'Failed to copy to the clipboard. pbcopy missing',
    ]);
  });
});

describe('/help', () => {
  it('lists every other command and the new keybindings, but does not list itself', async () => {
    const h = harness();
    await run('/help', h);
    expect(h.infoLines).toHaveLength(1);
    const text = h.infoLines[0];
    expect(text).toContain('/plan');
    expect(text).toContain('/status');
    expect(text).toContain('/exit, /quit');
    expect(text).toContain('/theme');
    expect(text).toContain('/clear, /new');
    expect(text).toContain('/copy');
    expect(text).toContain('Ctrl+F');
    expect(text).toContain('Ctrl+R');
    expect(text).toContain('@path');
    expect(text).not.toMatch(/\/help —/);
  });
});

describe('unknown command / non-command fallthrough', () => {
  it('reports an error for an unregistered command', async () => {
    const h = harness();
    const result = await run('/nonexistent', h);
    expect(result.handled).toBe(true);
    expect(h.errorLines[0]).toMatch(/Unknown command: \/nonexistent/);
  });

  it('leaves plain chat text unhandled so the caller sends it as a normal prompt', async () => {
    const h = harness();
    const result = await run('what is the weather', h);
    expect(result.handled).toBe(false);
    expect(h.infoLines).toHaveLength(0);
    expect(h.errorLines).toHaveLength(0);
  });
});
