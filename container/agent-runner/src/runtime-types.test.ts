import { describe, expect, it } from 'vitest';

import {
  CONTAINER_DISPATCH_BACKENDS,
  isContainerDispatchBackend,
} from './runtime-types.js';
import { getOpenAIToolDefinitions, VALID_BACKENDS } from './tool-broker.js';

describe('container dispatch backend identifiers', () => {
  it('accepts deus-native only on the internal process dispatch surface', () => {
    expect(CONTAINER_DISPATCH_BACKENDS).toEqual([
      'claude',
      'openai',
      'llama-cpp',
      'deus-native',
    ]);
    expect(isContainerDispatchBackend('deus-native')).toBe(true);
  });

  it('keeps user-facing broker backend selection byte-identical', () => {
    expect(VALID_BACKENDS).toEqual(['claude', 'openai', 'llama-cpp']);
    expect(VALID_BACKENDS).not.toContain('deus-native');

    for (const name of ['schedule_task', 'update_task', 'register_group']) {
      const definition = getOpenAIToolDefinitions().find(
        (tool) => tool.name === name,
      );
      expect(definition).toBeDefined();
      expect(
        (
          definition?.parameters.properties as Record<
            string,
            { enum?: string[] }
          >
        ).agent_backend.enum,
      ).toEqual(['claude', 'openai', 'llama-cpp']);
    }
  });
});
