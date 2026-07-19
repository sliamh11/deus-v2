import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock child_process before importing platform.ts
vi.mock('child_process', async () => {
  const actual =
    await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    execFileSync: vi.fn(),
  };
});

import { execFileSync } from 'child_process';
import {
  IS_WINDOWS,
  IS_MACOS,
  IS_LINUX,
  homeDir,
  killProcess,
  forceKillProcess,
  processExists,
  getProcessStartIdentity,
  getProcessCommandLine,
  containerBuildHint,
  detectProxyBindHost,
  hostGatewayArgs,
  isInteractiveTerminal,
} from './platform.js';

const mockExecFileSync = vi.mocked(execFileSync);

describe('platform detection', () => {
  it('exactly one of IS_WINDOWS, IS_MACOS, IS_LINUX is true', () => {
    const trueCount = [IS_WINDOWS, IS_MACOS, IS_LINUX].filter(Boolean).length;
    expect(trueCount).toBe(1);
  });

  it('homeDir is a non-empty string', () => {
    expect(typeof homeDir).toBe('string');
    expect(homeDir.length).toBeGreaterThan(0);
  });
});

describe('killProcess', () => {
  beforeEach(() => {
    mockExecFileSync.mockReset();
  });

  it('does not throw for non-existent PID', () => {
    expect(() => killProcess(999999999)).not.toThrow();
  });
});

describe('forceKillProcess', () => {
  beforeEach(() => {
    mockExecFileSync.mockReset();
  });

  it('does not throw for non-existent PID', () => {
    expect(() => forceKillProcess(999999999)).not.toThrow();
  });
});

describe('processExists', () => {
  it('returns true for own PID', () => {
    expect(processExists(process.pid)).toBe(true);
  });

  it('returns false for non-existent PID', () => {
    expect(processExists(999999999)).toBe(false);
  });
});

describe('getProcessStartIdentity', () => {
  beforeEach(() => {
    mockExecFileSync.mockReset();
  });

  it('returns unverifiable on Windows', () => {
    if (IS_WINDOWS) {
      expect(getProcessStartIdentity(process.pid)).toEqual({
        status: 'unverifiable',
      });
    }
  });

  it('returns the trimmed ps output as "found" on non-Windows', () => {
    if (IS_WINDOWS) return;
    mockExecFileSync.mockReturnValue(Buffer.from('Fri Jul 19 10:23:45 2026\n'));
    const result = getProcessStartIdentity(12345);
    expect(result).toEqual({
      status: 'found',
      value: 'Fri Jul 19 10:23:45 2026',
    });
    expect(mockExecFileSync).toHaveBeenCalledWith(
      'ps',
      ['-o', 'lstart=', '-p', '12345'],
      expect.anything(),
    );
  });

  it('returns "not_found" when ps throws (no such process)', () => {
    if (IS_WINDOWS) return;
    mockExecFileSync.mockImplementation(() => {
      throw new Error('no such process');
    });
    expect(getProcessStartIdentity(999999999)).toEqual({
      status: 'not_found',
    });
  });

  it('returns "not_found" when ps returns empty output', () => {
    if (IS_WINDOWS) return;
    mockExecFileSync.mockReturnValue(Buffer.from(''));
    expect(getProcessStartIdentity(999999999)).toEqual({
      status: 'not_found',
    });
  });
});

describe('getProcessCommandLine', () => {
  beforeEach(() => {
    mockExecFileSync.mockReset();
  });

  it('returns unverifiable on Windows', () => {
    if (IS_WINDOWS) {
      expect(getProcessCommandLine(process.pid)).toEqual({
        status: 'unverifiable',
      });
    }
  });

  it('returns the trimmed ps output as "found" on non-Windows', () => {
    if (IS_WINDOWS) return;
    mockExecFileSync.mockReturnValue(
      Buffer.from('claude --print --no-session-persistence\n'),
    );
    const result = getProcessCommandLine(12345);
    expect(result).toEqual({
      status: 'found',
      value: 'claude --print --no-session-persistence',
    });
    expect(mockExecFileSync).toHaveBeenCalledWith(
      'ps',
      ['-o', 'args=', '-p', '12345'],
      expect.anything(),
    );
  });

  it('returns "not_found" when ps throws (no such process)', () => {
    if (IS_WINDOWS) return;
    mockExecFileSync.mockImplementation(() => {
      throw new Error('no such process');
    });
    expect(getProcessCommandLine(999999999)).toEqual({ status: 'not_found' });
  });
});

describe('containerBuildHint', () => {
  it('is a non-empty string', () => {
    expect(typeof containerBuildHint).toBe('string');
    expect(containerBuildHint.length).toBeGreaterThan(0);
  });

  it('mentions docker build on Windows', () => {
    if (IS_WINDOWS) {
      expect(containerBuildHint).toContain('docker build');
    }
  });

  it('mentions build.sh on non-Windows', () => {
    if (!IS_WINDOWS) {
      expect(containerBuildHint).toContain('build.sh');
    }
  });
});

describe('detectProxyBindHost', () => {
  it('returns a valid IP address', () => {
    const host = detectProxyBindHost();
    expect(host).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
  });
});

describe('hostGatewayArgs', () => {
  it('returns an array', () => {
    expect(Array.isArray(hostGatewayArgs())).toBe(true);
  });

  it('includes add-host on Linux only', () => {
    const args = hostGatewayArgs();
    if (IS_LINUX) {
      expect(args.length).toBeGreaterThan(0);
      expect(args[0]).toContain('host.docker.internal');
    } else {
      expect(args).toEqual([]);
    }
  });
});

describe('isInteractiveTerminal', () => {
  it('returns a boolean (never undefined, via the ?? false guard)', () => {
    expect(typeof isInteractiveTerminal()).toBe('boolean');
  });
});
