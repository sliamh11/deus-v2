import { describe, expect, it } from 'vitest';

import {
  createPermissionCheckMcpServer,
  handleCheckPermission,
} from './permission-check-mcp-server.js';

describe('handleCheckPermission', () => {
  it('denies write_file under the read-only profile, sourced from an explicit rule', () => {
    const result = handleCheckPermission({
      toolName: 'write_file',
      probeId: 'probe-1',
    });
    expect(result).toMatchObject({
      probeId: 'probe-1',
      profile: 'read-only',
      toolName: 'write_file',
      decision: 'deny',
      source: 'rule',
    });
    expect(result.matchedRuleIndex).toBeDefined();
    expect(typeof result.pid).toBe('number');
    expect(result.pid).toBe(process.pid);
  });

  it('allows read_file under the read-only profile', () => {
    const result = handleCheckPermission({
      toolName: 'read_file',
      probeId: 'probe-2',
    });
    expect(result).toMatchObject({
      decision: 'allow',
      source: 'rule',
      toolName: 'read_file',
    });
  });

  it('fail-closed denies an unknown tool name via the profile default', () => {
    const result = handleCheckPermission({
      toolName: 'some_unlisted_tool',
      probeId: 'probe-3',
    });
    expect(result).toMatchObject({
      decision: 'deny',
      source: 'default',
      matchedRuleIndex: undefined,
    });
  });

  it('echoes back the exact probeId given, distinguishing calls', () => {
    const first = handleCheckPermission({
      toolName: 'write_file',
      probeId: 'unique-probe-abc123',
    });
    const second = handleCheckPermission({
      toolName: 'write_file',
      probeId: 'different-probe-xyz789',
    });
    expect(first.probeId).toBe('unique-probe-abc123');
    expect(second.probeId).toBe('different-probe-xyz789');
  });

  it('is deterministic for the same inputs (aside from pid, which is constant per process)', () => {
    const a = handleCheckPermission({ toolName: 'bash_exec', probeId: 'p' });
    const b = handleCheckPermission({ toolName: 'bash_exec', probeId: 'p' });
    expect(a).toEqual(b);
  });
});

describe('createPermissionCheckMcpServer', () => {
  it('constructs an MCP server without starting any transport (no stdio connect)', () => {
    // If this ever started a real stdio transport as a side effect, the
    // test process would hang waiting on stdin. It doesn't: construction is
    // separated from the `invokedDirectly`-gated `server.connect(...)` at
    // module load time.
    const server = createPermissionCheckMcpServer();
    expect(server).toBeDefined();
  });
});
