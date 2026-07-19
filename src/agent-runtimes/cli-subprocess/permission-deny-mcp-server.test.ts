import { describe, expect, it } from 'vitest';

import {
  createPermissionDenyMcpServer,
  handleAllowProbe,
  handleDenyProbe,
} from './permission-deny-mcp-server.js';

describe('handleDenyProbe', () => {
  it('always returns a real MCP isError:true result for write_file under read-only', () => {
    const result = handleDenyProbe({ probeId: 'probe-deny-1' });
    expect(result.isError).toBe(true);
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe('text');
  });

  it("mirrors middleware-stack.ts's permission_denied wording byte-for-byte", () => {
    const result = handleDenyProbe({ probeId: 'probe-deny-2' });
    expect(result.content[0].text).toContain(
      'permission_denied: tool "write_file" was blocked by the ' +
        '"read-only" permission profile',
    );
    expect(result.content[0].text).toContain(
      'The call was not executed; continue without this tool.',
    );
  });

  it('includes the real evaluatePermission reason, not a hand-written one', () => {
    const result = handleDenyProbe({ probeId: 'probe-deny-3' });
    expect(result.content[0].text).toContain(
      'tool "write_file" is explicitly denied by rule',
    );
  });

  it('echoes back the exact probeId given, inside the error text', () => {
    const result = handleDenyProbe({ probeId: 'unique-probe-xyz' });
    expect(result.content[0].text).toContain('(probeId: unique-probe-xyz)');
  });

  it('is deterministic for the same input', () => {
    const a = handleDenyProbe({ probeId: 'p' });
    const b = handleDenyProbe({ probeId: 'p' });
    expect(a).toEqual(b);
  });
});

describe('handleAllowProbe', () => {
  it('returns a normal (non-error) result for web_search under read-only', () => {
    const result = handleAllowProbe({ probeId: 'probe-allow-1' });
    expect('isError' in result).toBe(false);
    expect(result.content).toHaveLength(1);
  });

  it('reports decision:allow and the probed tool name in the JSON body', () => {
    const result = handleAllowProbe({ probeId: 'probe-allow-2' });
    const parsed = JSON.parse(result.content[0].text) as {
      probeId: string;
      decision: string;
      toolName: string;
    };
    expect(parsed).toEqual({
      probeId: 'probe-allow-2',
      decision: 'allow',
      toolName: 'web_search',
    });
  });

  it('is deterministic for the same input', () => {
    const a = handleAllowProbe({ probeId: 'p' });
    const b = handleAllowProbe({ probeId: 'p' });
    expect(a).toEqual(b);
  });
});

describe('createPermissionDenyMcpServer', () => {
  it('constructs an MCP server without starting any transport (no stdio connect)', () => {
    const server = createPermissionDenyMcpServer();
    expect(server).toBeDefined();
  });
});
