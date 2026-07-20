import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  MCP_READY_MARKER_ENV_VAR,
  writeMcpReadyMarkerIfRequested,
} from './mcp-ready-marker.js';

let scratchDir: string;

beforeEach(() => {
  scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lia461-marker-test-'));
});

afterEach(() => {
  fs.rmSync(scratchDir, { recursive: true, force: true });
});

describe('writeMcpReadyMarkerIfRequested', () => {
  it('is a no-op when the env var is absent (default-unchanged for every non-opted-in caller)', () => {
    expect(() => writeMcpReadyMarkerIfRequested({})).not.toThrow();
  });

  it('is a no-op when the env var is set to an empty string', () => {
    expect(() =>
      writeMcpReadyMarkerIfRequested({ [MCP_READY_MARKER_ENV_VAR]: '' }),
    ).not.toThrow();
  });

  it('writes an empty marker file at the requested path when the env var is set', () => {
    const markerPath = path.join(scratchDir, 'mcp-ready.marker');
    expect(fs.existsSync(markerPath)).toBe(false);
    writeMcpReadyMarkerIfRequested({ [MCP_READY_MARKER_ENV_VAR]: markerPath });
    expect(fs.existsSync(markerPath)).toBe(true);
    expect(fs.readFileSync(markerPath, 'utf8')).toBe('');
  });

  it('defaults to process.env when no env argument is supplied', () => {
    const markerPath = path.join(scratchDir, 'mcp-ready.marker');
    const original = process.env[MCP_READY_MARKER_ENV_VAR];
    process.env[MCP_READY_MARKER_ENV_VAR] = markerPath;
    try {
      writeMcpReadyMarkerIfRequested();
      expect(fs.existsSync(markerPath)).toBe(true);
    } finally {
      if (original === undefined) delete process.env[MCP_READY_MARKER_ENV_VAR];
      else process.env[MCP_READY_MARKER_ENV_VAR] = original;
    }
  });
});
