import { describe, expect, it } from 'vitest';

import { RuntimeActivityBroadcaster } from './activity-broadcaster.js';
import {
  ContainerRuntime,
  type ContainerRuntimeDeps,
} from './container-backend.js';
import { createProductionRuntimeRegistry } from './production-registry.js';
import { resolveAgentRuntime } from './resolve.js';
import type { RegisteredGroup } from '../types.js';

const deps: ContainerRuntimeDeps = {
  resolveGroup: () => undefined,
  assistantName: 'Deus',
  registerProcess: () => undefined,
};

const nativeGroup: RegisteredGroup = {
  name: 'Native test group',
  folder: 'native-test',
  trigger: '@Deus',
  added_at: '2026-07-17T00:00:00.000Z',
  containerConfig: { agentBackend: 'deus-native' },
};

function compileOnlyContainerRuntimeExclusion(): void {
  // Compile-time oracle: widening ContainerBackendId makes this directive
  // unused and fails `npm run typecheck`. This function is never invoked.
  // @ts-expect-error deus-native is never a production ContainerRuntime
  new ContainerRuntime('deus-native', {} as never, deps);
}

describe('createProductionRuntimeRegistry', () => {
  it('keeps deus-native production resolution on the host-native runtime', () => {
    const broadcaster = new RuntimeActivityBroadcaster();
    const registry = createProductionRuntimeRegistry(deps, broadcaster);
    const resolvedName = resolveAgentRuntime(nativeGroup);
    const runtime = registry.get(resolvedName);

    expect(resolvedName).toBe('deus-native');
    expect(runtime.name()).toBe('deus-native');
    expect(runtime).not.toBeInstanceOf(ContainerRuntime);
    expect(runtime.capabilities()).toMatchObject({
      shell: false,
      filesystem: false,
      web: true,
    });

    broadcaster.close();
  });

  it('keeps ContainerRuntime constructor typing closed to deus-native', () => {
    expect(compileOnlyContainerRuntimeExclusion).toBeTypeOf('function');
  });
});
