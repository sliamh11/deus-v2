import { describe, expect, it, vi } from 'vitest';

import {
  createSlashCommandRegistry,
  executeSlashCommand,
  parseSlashCommandLine,
  UNKNOWN_COMMAND_MESSAGE,
} from './registry.js';
import {
  CommandKind,
  type SlashCommand,
  type SlashCommandContext,
} from './types.js';

function fakeContext(
  overrides: Partial<SlashCommandContext> = {},
): SlashCommandContext {
  return {
    invocation: { raw: '', name: '', args: '' },
    services: {
      transport: {
        turn: vi.fn(),
        respondPermission: vi.fn(),
        setPlanMode: vi.fn(),
        status: vi.fn(),
        close: vi.fn(),
      } as never,
      themeManager: {
        getActiveTheme: () => ({ name: 'deus-default' }),
        setActiveTheme: () => true,
        getAvailableThemes: () => [],
      },
      clipboard: vi.fn(async () => {}),
    },
    ui: {
      info: vi.fn(),
      error: vi.fn(),
      clear: vi.fn(),
      lastAssistantText: () => undefined,
    },
    cwd: '/work',
    onExit: vi.fn(),
    ...overrides,
  };
}

describe('parseSlashCommandLine', () => {
  it('splits a name and trimmed args', () => {
    expect(parseSlashCommandLine('/plan on')).toEqual({
      name: 'plan',
      args: 'on',
    });
    expect(parseSlashCommandLine('/theme   dracula  ')).toEqual({
      name: 'theme',
      args: 'dracula',
    });
  });

  it('lowercases the command name but not the args', () => {
    expect(parseSlashCommandLine('/PLAN ON')).toEqual({
      name: 'plan',
      args: 'ON',
    });
  });

  it('handles a bare command with no args', () => {
    expect(parseSlashCommandLine('/status')).toEqual({
      name: 'status',
      args: '',
    });
  });

  it('returns undefined for non-slash text', () => {
    expect(parseSlashCommandLine('hello there')).toBeUndefined();
  });

  it('returns undefined for a bare slash or a slash followed by whitespace', () => {
    expect(parseSlashCommandLine('/')).toBeUndefined();
    expect(parseSlashCommandLine('/ foo')).toBeUndefined();
  });

  it('trims surrounding whitespace on the raw line before parsing', () => {
    expect(parseSlashCommandLine('   /clear  ')).toEqual({
      name: 'clear',
      args: '',
    });
  });
});

describe('createSlashCommandRegistry', () => {
  const ping: SlashCommand = {
    name: 'ping',
    altNames: ['p'],
    description: 'ping',
    kind: CommandKind.BUILT_IN,
    action: vi.fn(),
  };
  const registry = createSlashCommandRegistry([ping]);

  it('finds a command by its primary name, case-insensitively', () => {
    expect(registry.find('ping')).toBe(ping);
    expect(registry.find('PING')).toBe(ping);
  });

  it('finds a command by an alt name', () => {
    expect(registry.find('p')).toBe(ping);
  });

  it('returns undefined for an unregistered name', () => {
    expect(registry.find('nope')).toBeUndefined();
  });
});

describe('executeSlashCommand', () => {
  it('returns handled:false and does nothing for non-slash input', async () => {
    const registry = createSlashCommandRegistry([]);
    const context = fakeContext();
    const result = await executeSlashCommand(registry, 'hello agent', context);
    expect(result).toEqual({ handled: false });
    expect(context.ui.info).not.toHaveBeenCalled();
    expect(context.ui.error).not.toHaveBeenCalled();
  });

  it('reports an error and returns handled:true for an unknown command', async () => {
    const registry = createSlashCommandRegistry([]);
    const context = fakeContext();
    const result = await executeSlashCommand(registry, '/nope', context);
    expect(result).toEqual({ handled: true });
    expect(context.ui.error).toHaveBeenCalledWith(
      UNKNOWN_COMMAND_MESSAGE('nope'),
    );
  });

  it('runs the matched command action with the parsed invocation', async () => {
    const action = vi.fn();
    const registry = createSlashCommandRegistry([
      { name: 'echo', description: '', kind: CommandKind.BUILT_IN, action },
    ]);
    const context = fakeContext();
    await executeSlashCommand(registry, '/echo hello world', context);

    expect(action).toHaveBeenCalledTimes(1);
    const [calledContext, calledArgs] = action.mock.calls[0];
    expect(calledArgs).toBe('hello world');
    expect(calledContext.invocation).toEqual({
      raw: '/echo hello world',
      name: 'echo',
      args: 'hello world',
    });
  });

  it('applies a "message" action return to ui.info for messageType info', async () => {
    const registry = createSlashCommandRegistry([
      {
        name: 'note',
        description: '',
        kind: CommandKind.BUILT_IN,
        action: () => ({
          type: 'message' as const,
          messageType: 'info' as const,
          content: 'hi',
        }),
      },
    ]);
    const context = fakeContext();
    await executeSlashCommand(registry, '/note', context);
    expect(context.ui.info).toHaveBeenCalledWith('hi');
  });

  it('applies a "message" action return to ui.error for messageType error', async () => {
    const registry = createSlashCommandRegistry([
      {
        name: 'bad',
        description: '',
        kind: CommandKind.BUILT_IN,
        action: () => ({
          type: 'message' as const,
          messageType: 'error' as const,
          content: 'oops',
        }),
      },
    ]);
    const context = fakeContext();
    await executeSlashCommand(registry, '/bad', context);
    expect(context.ui.error).toHaveBeenCalledWith('oops');
  });

  it('applies a "quit" action return by calling onExit', async () => {
    const registry = createSlashCommandRegistry([
      {
        name: 'bye',
        description: '',
        kind: CommandKind.BUILT_IN,
        action: () => ({ type: 'quit' as const }),
      },
    ]);
    const context = fakeContext();
    await executeSlashCommand(registry, '/bye', context);
    expect(context.onExit).toHaveBeenCalledTimes(1);
  });

  it('catches a thrown action error and reports it via ui.error instead of propagating', async () => {
    const registry = createSlashCommandRegistry([
      {
        name: 'boom',
        description: '',
        kind: CommandKind.BUILT_IN,
        action: () => {
          throw new Error('kaboom');
        },
      },
    ]);
    const context = fakeContext();
    const result = await executeSlashCommand(registry, '/boom', context);
    expect(result).toEqual({ handled: true });
    expect(context.ui.error).toHaveBeenCalledWith('/boom failed: kaboom');
  });

  it('resolves a command by its alt name', async () => {
    const action = vi.fn();
    const registry = createSlashCommandRegistry([
      {
        name: 'exit',
        altNames: ['quit'],
        description: '',
        kind: CommandKind.BUILT_IN,
        action,
      },
    ]);
    const context = fakeContext();
    await executeSlashCommand(registry, '/quit', context);
    expect(action).toHaveBeenCalledTimes(1);
  });
});
