import { describe, expect, it } from 'vitest';

import {
  DEFAULT_NATIVE_MODEL,
  parseEffectiveNativeModelConfig,
  parseNativeModelConfig,
  resolveEffectiveNativeModelConfig,
  resolveEffectiveRoleModel,
  validateNativeModelRef,
  validateNativeRole,
} from './model-selection.js';

describe('native model selection', () => {
  it('uses the preserved default and exact role > main precedence', () => {
    expect(parseEffectiveNativeModelConfig(undefined)).toEqual({
      main: DEFAULT_NATIVE_MODEL,
      roles: {},
    });
    const config = resolveEffectiveNativeModelConfig(
      parseNativeModelConfig({
        version: 1,
        main: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
        roles: {
          researcher: {
            provider: 'anthropic',
            model: 'claude-haiku-4-5-20251001',
          },
        },
      }),
    );
    expect(resolveEffectiveRoleModel(config, 'researcher').model).toBe(
      'claude-haiku-4-5-20251001',
    );
    expect(resolveEffectiveRoleModel(config, 'writer').model).toBe(
      'claude-sonnet-4-6',
    );
  });

  it('rejects unsupported providers and models actionably', () => {
    expect(() =>
      validateNativeModelRef({ provider: 'openai', model: 'x' }),
    ).toThrow(/Supported providers: anthropic/);
    expect(() =>
      validateNativeModelRef({ provider: 'anthropic', model: 'x' }),
    ).toThrow(/claude-sonnet-4-6/);
  });

  it.each(['toString', 'constructor'])(
    'rejects inherited provider name %s as unknown',
    (provider) => {
      expect(() => validateNativeModelRef({ provider, model: 'x' })).toThrow(
        /Unknown provider/,
      );
    },
  );

  it.each(['toString', 'constructor'])(
    'falls back to main for inherited role name %s',
    (role) => {
      const main = {
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
      } as const;
      expect(resolveEffectiveRoleModel({ main, roles: {} }, role)).toBe(main);
    },
  );

  it('rejects malformed config, roles, and reserved main', () => {
    expect(() => parseNativeModelConfig({ version: 2, roles: {} })).toThrow(
      /version/,
    );
    expect(() => parseNativeModelConfig({ version: 1, roles: [] })).toThrow(
      /roles/,
    );
    expect(() => validateNativeRole('main')).toThrow(/reserved/);
    expect(() => validateNativeRole('bad role')).toThrow(/must match/);
  });
});
