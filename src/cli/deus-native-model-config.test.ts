import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { IS_WINDOWS } from '../platform.js';

import {
  formatNativeModelConfig,
  loadNativeModelConfig,
  setNativeModel,
} from './deus-native-model-config.js';

const dirs: string[] = [];
function file(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deus-native-models-'));
  dirs.push(dir);
  return path.join(dir, 'nested', 'native-models.json');
}
afterEach(() =>
  dirs
    .splice(0)
    .forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })),
);

describe('native model config persistence', () => {
  it('treats missing as default and preserves main/other roles across atomic updates', () => {
    const target = file();
    expect(loadNativeModelConfig(target)).toEqual({ version: 1, roles: {} });
    setNativeModel(
      { provider: 'anthropic', model: 'claude-sonnet-4-6' },
      undefined,
      target,
    );
    setNativeModel(
      { provider: 'anthropic', model: 'claude-haiku-4-5-20251001' },
      'researcher',
      target,
    );
    expect(loadNativeModelConfig(target)).toMatchObject({
      main: { model: 'claude-sonnet-4-6' },
      roles: { researcher: { model: 'claude-haiku-4-5-20251001' } },
    });
    expect(fs.readdirSync(path.dirname(target))).toEqual([
      'native-models.json',
    ]);
    if (!IS_WINDOWS) expect(fs.statSync(target).mode & 0o777).toBe(0o600);
  });

  it('refuses malformed existing files without overwriting them', () => {
    const target = file();
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, '{broken');
    expect(() =>
      setNativeModel(
        { provider: 'anthropic', model: 'claude-opus-4-8' },
        undefined,
        target,
      ),
    ).toThrow(/Malformed/);
    expect(fs.readFileSync(target, 'utf8')).toBe('{broken');
  });

  it('formats configured, default, and inherited selections', () => {
    expect(formatNativeModelConfig({ version: 1, roles: {} })).toContain(
      '(default)',
    );
    expect(
      formatNativeModelConfig(
        {
          version: 1,
          main: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
          roles: {},
        },
        'writer',
      ),
    ).toContain('(inherits main)');
  });
});
