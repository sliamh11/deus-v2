import type { BaseChatModel } from '@langchain/core/language_models/chat_models';

import { buildProxyRoutedChatAnthropic } from './deus-native-model.js';
import type { RunContext } from './types.js';

export type NativeModelProvider = 'anthropic';

export interface NativeModelRef {
  provider: NativeModelProvider;
  model: string;
}

export interface NativeModelConfigV1 {
  version: 1;
  main?: NativeModelRef;
  roles: Record<string, NativeModelRef>;
}

export interface EffectiveNativeModelConfig {
  main: NativeModelRef;
  roles: Record<string, NativeModelRef>;
}

interface NativeProviderDefinition {
  models: readonly string[];
  defaultModel: string;
  buildClient(runContext: RunContext, model: string): BaseChatModel;
}

export const NATIVE_PROVIDER_REGISTRY: Record<
  NativeModelProvider,
  NativeProviderDefinition
> = {
  anthropic: {
    models: [
      'claude-opus-4-8',
      'claude-sonnet-4-6',
      'claude-haiku-4-5-20251001',
    ],
    defaultModel: 'claude-opus-4-8',
    buildClient: buildProxyRoutedChatAnthropic,
  },
};

export const DEFAULT_NATIVE_MODEL: NativeModelRef = Object.freeze({
  provider: 'anthropic',
  model: NATIVE_PROVIDER_REGISTRY.anthropic.defaultModel,
});

const ROLE_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function validateNativeRole(role: string): void {
  if (role === 'main') {
    throw new Error(
      'Role "main" is reserved. Omit --role to configure the main agent.',
    );
  }
  if (!ROLE_PATTERN.test(role)) {
    throw new Error(
      `Invalid role "${role}". Roles must match [A-Za-z][A-Za-z0-9_-]{0,63}.\n` +
        'Use: deus chat model set --role <role> --provider anthropic --model <model>',
    );
  }
}

export function validateNativeModelRef(value: unknown): NativeModelRef {
  if (!object(value))
    throw new Error(
      'Model selection must be an object with provider and model.',
    );
  const provider = value.provider;
  const model = value.model;
  if (
    typeof provider !== 'string' ||
    !Object.hasOwn(NATIVE_PROVIDER_REGISTRY, provider)
  ) {
    throw new Error(
      `Unknown provider "${String(provider)}". Supported providers: ${Object.keys(NATIVE_PROVIDER_REGISTRY).join(', ')}.\n` +
        'Use: deus chat model set --provider anthropic --model <model>',
    );
  }
  const definition = NATIVE_PROVIDER_REGISTRY[provider as NativeModelProvider];
  if (typeof model !== 'string' || !definition.models.includes(model)) {
    throw new Error(
      `Unknown model "${String(model)}" for provider "${provider}".\n` +
        `Supported models: ${definition.models.join(', ')}.\n` +
        `Use: deus chat model set --provider ${provider} --model ${definition.models[1] ?? definition.defaultModel}`,
    );
  }
  return { provider: provider as NativeModelProvider, model };
}

function parseRoles(value: unknown): Record<string, NativeModelRef> {
  if (!object(value))
    throw new Error(
      'Native model configuration requires an object-shaped "roles" field.',
    );
  const roles: Record<string, NativeModelRef> = {};
  for (const [role, ref] of Object.entries(value)) {
    validateNativeRole(role);
    roles[role] = validateNativeModelRef(ref);
  }
  return roles;
}

export function parseNativeModelConfig(value: unknown): NativeModelConfigV1 {
  if (!object(value))
    throw new Error('Native model configuration must be a JSON object.');
  if (value.version !== 1)
    throw new Error(
      `Unsupported native model configuration version "${String(value.version)}". Expected version 1.`,
    );
  const roles = parseRoles(value.roles);
  return {
    version: 1,
    ...(value.main !== undefined
      ? { main: validateNativeModelRef(value.main) }
      : {}),
    roles,
  };
}

export function parseEffectiveNativeModelConfig(
  value: unknown,
): EffectiveNativeModelConfig {
  if (value === undefined)
    return { main: { ...DEFAULT_NATIVE_MODEL }, roles: {} };
  if (!object(value))
    throw new Error(
      'deus-native: backendConfig.modelSelection must be an object',
    );
  if (value.main === undefined)
    throw new Error(
      'deus-native: backendConfig.modelSelection.main is required',
    );
  return {
    main: validateNativeModelRef(value.main),
    roles: parseRoles(value.roles),
  };
}

export function resolveEffectiveNativeModelConfig(
  config: NativeModelConfigV1,
): EffectiveNativeModelConfig {
  return {
    main: config.main ?? { ...DEFAULT_NATIVE_MODEL },
    roles: { ...config.roles },
  };
}

export function resolveEffectiveRoleModel(
  config: EffectiveNativeModelConfig,
  role: string,
): NativeModelRef {
  return Object.hasOwn(config.roles, role) ? config.roles[role] : config.main;
}

export function buildNativeModelClient(
  runContext: RunContext,
  ref: NativeModelRef,
): BaseChatModel {
  const validated = validateNativeModelRef(ref);
  return NATIVE_PROVIDER_REGISTRY[validated.provider].buildClient(
    runContext,
    validated.model,
  );
}
