import { describe, expect, it, vi } from 'vitest';

const wiring = vi.hoisted(() => {
  const nativeRuntime = {
    name: () => 'deus-native' as const,
    capabilities: () => ({
      shell: false,
      filesystem: false,
      web: true,
      multimodal: true,
      handoffs: false,
      persistent_sessions: true,
      tool_streaming: true,
    }),
    startOrResume: vi.fn(),
    runTurn: vi.fn(),
    close: vi.fn(),
  };
  return {
    nativeRuntime,
    createDeusNativeRuntime: vi.fn(() => nativeRuntime),
    withRuntimeActivityBroadcast: vi.fn((runtime) => runtime),
  };
});

vi.mock('./deus-native-backend.js', () => ({
  createDeusNativeRuntime: wiring.createDeusNativeRuntime,
}));

vi.mock('./activity-broadcaster.js', () => ({
  RuntimeActivityBroadcaster: class FakeRuntimeActivityBroadcaster {},
  withRuntimeActivityBroadcast: wiring.withRuntimeActivityBroadcast,
}));

import { RuntimeActivityBroadcaster } from './activity-broadcaster.js';
import type { ContainerRuntimeDeps } from './container-backend.js';
import { createProductionRuntimeRegistry } from './production-registry.js';
import type { RegisteredGroup } from '../types.js';

describe('production runtime registry wiring', () => {
  it('resolves deus-native through the host-native factory, not ContainerRuntime', () => {
    const deps: ContainerRuntimeDeps = {
      resolveGroup: () => undefined,
      assistantName: 'Deus',
      registerProcess: () => undefined,
    };
    const group: RegisteredGroup = {
      name: 'Native group',
      folder: 'native-group',
      trigger: '@Deus',
      added_at: '2026-07-17T00:00:00.000Z',
      containerConfig: { agentBackend: 'deus-native' },
    };
    const registry = createProductionRuntimeRegistry(
      deps,
      new RuntimeActivityBroadcaster(),
    );

    expect(registry.resolve(group)).toBe(wiring.nativeRuntime);
    expect(wiring.createDeusNativeRuntime).toHaveBeenCalledWith(deps);
    expect(wiring.withRuntimeActivityBroadcast).toHaveBeenCalledWith(
      wiring.nativeRuntime,
      expect.any(RuntimeActivityBroadcaster),
    );
  });
});
