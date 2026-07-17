import { describe, it, expect, vi } from 'vitest';
import {
  extractSessionCommand,
  dispatchHostCommand,
  handleSessionCommand,
  handleSettingsCommand,
  isSessionCommandAllowed,
} from './session-commands.js';
import type { NewMessage, RegisteredGroup } from './types.js';
import type { SessionCommandDeps } from './session-commands.js';

describe('extractSessionCommand', () => {
  const trigger = /^@Deus\b/i;

  it('detects bare /compact', () => {
    expect(extractSessionCommand('/compact', trigger)).toBe('/compact');
  });

  it('detects /compact with trigger prefix', () => {
    expect(extractSessionCommand('@Deus /compact', trigger)).toBe('/compact');
  });

  it('rejects /compact with extra text', () => {
    expect(extractSessionCommand('/compact now please', trigger)).toBeNull();
  });

  it('rejects partial matches', () => {
    expect(extractSessionCommand('/compaction', trigger)).toBeNull();
  });

  it('rejects regular messages', () => {
    expect(
      extractSessionCommand('please compact the conversation', trigger),
    ).toBeNull();
  });

  it('handles whitespace', () => {
    expect(extractSessionCommand('  /compact  ', trigger)).toBe('/compact');
  });

  it('is case-sensitive for the command', () => {
    expect(extractSessionCommand('/Compact', trigger)).toBeNull();
  });
});

describe('isSessionCommandAllowed', () => {
  it('allows main group regardless of sender', () => {
    expect(isSessionCommandAllowed(true, false)).toBe(true);
  });

  it('allows trusted/admin sender (is_from_me) in non-main group', () => {
    expect(isSessionCommandAllowed(false, true)).toBe(true);
  });

  it('denies untrusted sender in non-main group', () => {
    expect(isSessionCommandAllowed(false, false)).toBe(false);
  });

  it('allows trusted sender in main group', () => {
    expect(isSessionCommandAllowed(true, true)).toBe(true);
  });
});

function makeMsg(
  content: string,
  overrides: Partial<NewMessage> = {},
): NewMessage {
  return {
    id: 'msg-1',
    chat_jid: 'group@test',
    sender: 'user@test',
    sender_name: 'User',
    content,
    timestamp: '100',
    ...overrides,
  };
}

function makeDeps(
  overrides: Partial<SessionCommandDeps> = {},
): SessionCommandDeps {
  return {
    sendMessage: vi.fn().mockResolvedValue(undefined),
    setTyping: vi.fn().mockResolvedValue(undefined),
    runAgent: vi.fn().mockResolvedValue('success'),
    closeStdin: vi.fn(),
    advanceCursor: vi.fn(),
    formatMessages: vi.fn().mockReturnValue('<formatted>'),
    canSenderInteract: vi.fn().mockReturnValue(true),
    ...overrides,
  };
}

const trigger = /^@Deus\b/i;

describe('handleSessionCommand', () => {
  it('returns handled:false when no session command found', async () => {
    const deps = makeDeps();
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('hello')],
      isMainGroup: true,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result.handled).toBe(false);
  });

  it('handles authorized /compact in main group', async () => {
    const deps = makeDeps();
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/compact')],
      isMainGroup: true,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    expect(deps.runAgent).toHaveBeenCalledWith(
      '/compact',
      expect.any(Function),
    );
    expect(deps.advanceCursor).toHaveBeenCalledWith('100');
  });

  it('sends denial to interactable sender in non-main group', async () => {
    const deps = makeDeps();
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/compact', { is_from_me: false })],
      isMainGroup: false,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    expect(deps.sendMessage).toHaveBeenCalledWith(
      'Session commands require admin access.',
    );
    expect(deps.runAgent).not.toHaveBeenCalled();
    expect(deps.advanceCursor).toHaveBeenCalledWith('100');
  });

  it('silently consumes denied command when sender cannot interact', async () => {
    const deps = makeDeps({
      canSenderInteract: vi.fn().mockReturnValue(false),
    });
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/compact', { is_from_me: false })],
      isMainGroup: false,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    expect(deps.sendMessage).not.toHaveBeenCalled();
    expect(deps.advanceCursor).toHaveBeenCalledWith('100');
  });

  it('processes pre-compact messages before /compact', async () => {
    const deps = makeDeps();
    const msgs = [
      makeMsg('summarize this', { timestamp: '99' }),
      makeMsg('/compact', { timestamp: '100' }),
    ];
    const result = await handleSessionCommand({
      missedMessages: msgs,
      isMainGroup: true,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    expect(deps.formatMessages).toHaveBeenCalledWith([msgs[0]], 'UTC');
    // Two runAgent calls: pre-compact + /compact
    expect(deps.runAgent).toHaveBeenCalledTimes(2);
    expect(deps.runAgent).toHaveBeenCalledWith(
      '<formatted>',
      expect.any(Function),
    );
    expect(deps.runAgent).toHaveBeenCalledWith(
      '/compact',
      expect.any(Function),
    );
  });

  it('allows is_from_me sender in non-main group', async () => {
    const deps = makeDeps();
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/compact', { is_from_me: true })],
      isMainGroup: false,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    expect(deps.runAgent).toHaveBeenCalledWith(
      '/compact',
      expect.any(Function),
    );
  });

  it('reports failure when command-stage runAgent returns error without streamed status', async () => {
    // runAgent resolves 'error' but callback never gets status: 'error'
    const deps = makeDeps({
      runAgent: vi.fn().mockImplementation(async (prompt, onOutput) => {
        await onOutput({ status: 'success', result: null });
        return 'error';
      }),
    });
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/compact')],
      isMainGroup: true,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    expect(deps.sendMessage).toHaveBeenCalledWith(
      expect.stringContaining('failed'),
    );
  });

  it('returns success:false on pre-compact failure with no output', async () => {
    const deps = makeDeps({ runAgent: vi.fn().mockResolvedValue('error') });
    const msgs = [
      makeMsg('summarize this', { timestamp: '99' }),
      makeMsg('/compact', { timestamp: '100' }),
    ];
    const result = await handleSessionCommand({
      missedMessages: msgs,
      isMainGroup: true,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: false });
    expect(deps.sendMessage).toHaveBeenCalledWith(
      expect.stringContaining('Failed to process'),
    );
  });
});

// ── /settings memory_privacy ────────────────────────────────────────────────

function makeGroup(overrides: Partial<RegisteredGroup> = {}): RegisteredGroup {
  return {
    name: 'test-group',
    folder: 'test-group',
    trigger: '@Test',
    added_at: '2024-01-01',
    ...overrides,
  };
}

describe('handleSettingsCommand — memory_privacy', () => {
  it('sets valid privacy levels', () => {
    const group = makeGroup();
    const result = handleSettingsCommand(
      '/settings memory_privacy=public,internal,private',
      group,
      24,
    );
    expect(result.response).toBe(
      'memory_privacy set to public,internal,private',
    );
    expect(result.updatedGroup?.containerConfig?.memoryPrivacy).toEqual([
      'public',
      'internal',
      'private',
    ]);
  });

  it('rejects invalid privacy levels', () => {
    const group = makeGroup();
    const result = handleSettingsCommand(
      '/settings memory_privacy=public,bogus',
      group,
      24,
    );
    expect(result.response).toContain('Invalid privacy level(s): bogus');
    expect(result.updatedGroup).toBeUndefined();
  });

  it('rejects empty value', () => {
    const group = makeGroup();
    const result = handleSettingsCommand(
      '/settings memory_privacy=',
      group,
      24,
    );
    expect(result.response).toContain('Missing value');
    expect(result.updatedGroup).toBeUndefined();
  });

  it('includes sensitive when explicitly listed', () => {
    const group = makeGroup();
    const result = handleSettingsCommand(
      '/settings memory_privacy=sensitive',
      group,
      24,
    );
    expect(result.updatedGroup?.containerConfig?.memoryPrivacy).toEqual([
      'sensitive',
    ]);
  });

  it('displays current memory_privacy in settings output', () => {
    const group = makeGroup({
      containerConfig: { memoryPrivacy: ['public', 'internal'] },
    });
    const result = handleSettingsCommand('/settings', group, 24);
    expect(result.response).toContain('memory_privacy: public,internal');
  });

  it('displays default when no memory_privacy configured', () => {
    const group = makeGroup();
    const result = handleSettingsCommand('/settings', group, 24);
    expect(result.response).toContain(
      'memory_privacy: public,internal,private (default)',
    );
  });

  it('normalizes to lowercase', () => {
    const group = makeGroup();
    const result = handleSettingsCommand(
      '/settings memory_privacy=Public,INTERNAL',
      group,
      24,
    );
    expect(result.updatedGroup?.containerConfig?.memoryPrivacy).toEqual([
      'public',
      'internal',
    ]);
  });

  it('deduplicates levels', () => {
    const group = makeGroup();
    const result = handleSettingsCommand(
      '/settings memory_privacy=public,public,internal',
      group,
      24,
    );
    expect(result.updatedGroup?.containerConfig?.memoryPrivacy).toEqual([
      'public',
      'internal',
    ]);
  });
});

describe('handleSettingsCommand — effort', () => {
  it('sets valid effort level', () => {
    const group = makeGroup();
    const result = handleSettingsCommand('/settings effort=high', group, 24);
    expect(result.response).toBe('effort set to high');
    expect(result.updatedGroup?.containerConfig?.agentEffort).toBe('high');
  });

  it('rejects invalid effort level', () => {
    const group = makeGroup();
    const result = handleSettingsCommand('/settings effort=turbo', group, 24);
    expect(result.response).toContain('Invalid effort level: turbo');
    expect(result.updatedGroup).toBeUndefined();
  });

  it('normalizes to lowercase', () => {
    const group = makeGroup();
    const result = handleSettingsCommand('/settings effort=MAX', group, 24);
    expect(result.updatedGroup?.containerConfig?.agentEffort).toBe('max');
  });

  it('displays current effort in settings output', () => {
    const group = makeGroup({ containerConfig: { agentEffort: 'medium' } });
    const result = handleSettingsCommand('/settings', group, 24);
    expect(result.response).toContain('effort: medium');
  });

  it('displays default when no effort configured', () => {
    const group = makeGroup();
    const result = handleSettingsCommand('/settings', group, 24);
    expect(result.response).toContain('effort: low (default)');
  });
});

describe('handleSettingsCommand — backend', () => {
  it('sets deus-native when no container config exists', () => {
    const result = handleSettingsCommand(
      '/settings backend=deus-native',
      makeGroup(),
      24,
    );

    expect(result.response).toBe('backend set to deus-native');
    expect(result.updatedGroup?.containerConfig?.agentBackend).toBe(
      'deus-native',
    );
  });

  it('accepts every supported backend', () => {
    const supportedBackends = [
      'claude',
      'openai',
      'llama-cpp',
      'deus-native',
    ] as const;

    for (const backend of supportedBackends) {
      const result = handleSettingsCommand(
        `/settings backend=${backend}`,
        makeGroup(),
        24,
      );
      expect(result.updatedGroup?.containerConfig?.agentBackend).toBe(backend);
    }
  });

  it('preserves other container config fields when setting a backend', () => {
    const result = handleSettingsCommand(
      '/settings backend=deus-native',
      makeGroup({ containerConfig: { timeout: 60_000 } }),
      24,
    );

    expect(result.updatedGroup?.containerConfig).toEqual({
      timeout: 60_000,
      agentBackend: 'deus-native',
    });
  });

  it('rejects an invalid backend', () => {
    const result = handleSettingsCommand(
      '/settings backend=not-a-real-backend',
      makeGroup(),
      24,
    );

    expect(result.response).toBe(
      'Invalid backend: not-a-real-backend. Valid: claude, openai, llama-cpp, deus-native',
    );
    expect(result.updatedGroup).toBeUndefined();
  });

  it('displays the configured backend override', () => {
    const result = handleSettingsCommand(
      '/settings',
      makeGroup({ containerConfig: { agentBackend: 'deus-native' } }),
      24,
    );

    expect(result.response).toContain('  backend: deus-native');
  });

  it('displays global-default inheritance without an override', () => {
    const result = handleSettingsCommand('/settings', makeGroup(), 24);

    expect(result.response).toContain('  backend: (using global default)');
  });

  it('documents setting and resetting the backend', () => {
    const result = handleSettingsCommand(
      '/settings unknown=value',
      makeGroup(),
      24,
    );

    expect(result.response).toContain('backend=<value>');
    expect(result.response).toContain('backend=default');
  });

  it('clears the backend override while preserving other settings', () => {
    const result = handleSettingsCommand(
      '/settings backend=default',
      makeGroup({
        containerConfig: {
          agentBackend: 'deus-native',
          timeout: 60_000,
        },
      }),
      24,
    );

    expect(result.updatedGroup?.containerConfig?.agentBackend).toBeUndefined();
    expect(result.updatedGroup?.containerConfig?.timeout).toBe(60_000);
  });

  it('shows global-default inheritance after a backend reset', () => {
    const reset = handleSettingsCommand(
      '/settings backend=default',
      makeGroup({ containerConfig: { agentBackend: 'deus-native' } }),
      24,
    );
    const displayed = handleSettingsCommand(
      '/settings',
      reset.updatedGroup!,
      24,
    );

    expect(displayed.response).toContain('  backend: (using global default)');
  });

  it('dispatches through the host command registry', () => {
    const result = dispatchHostCommand(
      [
        makeMsg('/settings backend=deus-native', {
          is_from_me: true,
        }),
      ],
      trigger,
      makeGroup(),
      24,
      false,
    );

    expect(result.matched).toBe(true);
    expect(result.updatedGroup?.containerConfig?.agentBackend).toBe(
      'deus-native',
    );
  });
});
