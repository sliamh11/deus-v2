/**
 * Independent oracle for LIA-430 AC4: disabling plan mode restores the
 * permission profile configured before plan mode was enabled.
 *
 * This oracle is intentionally implementation-blind. It observes only the
 * controller's public toggle and the RunContext delivered to its injected
 * runtime. The explicit `read-only` baseline is load-bearing: it makes the
 * correct restored state observably different from the implicit/default
 * profile, so an implementation that hard-codes "default" on disable fails.
 *
 * RED before LIA-430: the controller has no configured-profile dependency or
 * plan-mode toggle. The production implementation must make this test green
 * without weakening its non-default restoration expectation.
 */

import { describe, expect, it } from 'vitest';

import type {
  AgentRuntime,
  RunContext,
  RuntimeSession,
} from '../agent-runtimes/types.js';
import {
  createDeusNativeChatController,
  type ChatDisplayEvent,
  type DeusNativeChatOptions,
  type NativeChatSessionStore,
} from './deus-native-chat.js';

// `models` became a required DeusNativeChatOptions field after G2/LIA-429
// landed (post-dates this oracle's authoring on the G3 branch). Its value is
// orthogonal to the AC4 permission-profile claim under test here, so a fixed
// fixture is supplied purely for type/shape compatibility with the merged
// controller — it does not touch the discriminating assertions below.
const OPTIONS: DeusNativeChatOptions = {
  cwd: '/tmp/native-chat-oracle',
  resume: true,
  models: {
    main: { provider: 'anthropic', model: 'claude-opus-4-8' },
    roles: {},
  },
};

function recordingRuntime(): {
  runtime: AgentRuntime;
  runContexts: RunContext[];
} {
  const runContexts: RunContext[] = [];
  const session: RuntimeSession = {
    backend: 'deus-native',
    session_id: '43000000-0000-4000-8000-000000000004',
  };
  const runtime: AgentRuntime = {
    name: () => 'deus-native',
    capabilities: () => ({
      shell: false,
      filesystem: false,
      web: true,
      multimodal: false,
      handoffs: false,
      persistent_sessions: true,
      tool_streaming: false,
    }),
    startOrResume: async () => ({
      backend: 'deus-native',
      session_id: '',
    }),
    runTurn: async (runContext) => {
      runContexts.push(runContext);
      return {
        status: 'success',
        result: 'ok',
        sessionRef: session,
      };
    },
    close: async () => {},
  };
  return { runtime, runContexts };
}

function memoryStore(): NativeChatSessionStore {
  const rows = new Map<string, RuntimeSession>();
  return {
    get: (groupFolder, backend) => rows.get(`${groupFolder}:${backend}`),
    set: (groupFolder, session) =>
      rows.set(`${groupFolder}:${session.backend}`, session),
  };
}

const discard = (_event: ChatDisplayEvent): void => {};

describe('@oracle LIA-430 plan-mode profile restoration', () => {
  it('restores the explicit non-default profile after plan mode is disabled', async () => {
    // @oracle: LIA-430 AC4 — disabling plan mode restores the PRIOR configured
    // permission profile; it must not reset an explicit non-default profile
    // to the implicit `default` profile.
    const { runtime, runContexts } = recordingRuntime();
    const controller = createDeusNativeChatController({
      runtime,
      sessions: memoryStore(),
      configuredPermissionProfile: 'read-only',
    });
    await controller.start();

    await controller.runTurn('before plan mode', OPTIONS, discard);
    controller.setPlanMode(true);
    await controller.runTurn('during plan mode', OPTIONS, discard);
    controller.setPlanMode(false);
    await controller.runTurn('after plan mode', OPTIONS, discard);

    expect(runContexts).toHaveLength(3);
    // modelSelection rides along on every call (G2/LIA-429, unconditional);
    // the discriminating claim is permissionProfile staying 'read-only'
    // across the full before/during/after plan-mode cycle.
    expect(runContexts[0]?.backendConfig).toEqual({
      modelSelection: OPTIONS.models,
      permissionProfile: 'read-only',
    });
    expect(runContexts[1]?.backendConfig).toEqual({
      modelSelection: OPTIONS.models,
      permissionProfile: 'read-only',
    });
    expect(runContexts[2]?.backendConfig).toEqual({
      modelSelection: OPTIONS.models,
      permissionProfile: 'read-only',
    });
    expect(runContexts[2]?.backendConfig).not.toEqual({
      modelSelection: OPTIONS.models,
      permissionProfile: 'default',
    });
    expect(runContexts[2]?.backendConfig).not.toBeUndefined();
  });
});
