import {
  RuntimeActivityBroadcaster,
  withRuntimeActivityBroadcast,
} from './activity-broadcaster.js';
import type { SessionAlwaysAllowGrants } from './always-allow-grants.js';
import { createClaudeRuntime } from './claude-backend.js';
import type { ContainerRuntimeDeps } from './container-backend.js';
import { createDeusNativeRuntime } from './deus-native-backend.js';
import { createLlamaCppRuntime } from './llama-cpp-backend.js';
import { createOpenAIRuntime } from './openai-backend.js';
import type { PendingPermissionRegistry } from './permission-registry.js';
import { initRuntimeRegistry, type RuntimeRegistry } from './registry.js';

/**
 * Build the daemon's production runtime registry.
 *
 * LIA-423 deliberately does not register a ContainerRuntime for deus-native:
 * direct container-agent-runner dispatch is a protocol-portability proof,
 * while normal production resolution continues to use the host-native runtime.
 *
 * `permissionRegistry` (optional): the process-wide pending-permission
 * registry for interactive 'ask' prompts (Amendment 2026-07-21 in
 * docs/decisions/deus-v2-permission-rules.md). Threaded only into the
 * deus-native runtime; when omitted, an 'ask' verdict fails closed to deny.
 *
 * `alwaysAllowGrants` (optional): the process-wide session-scoped
 * `allow_always` grant store (2026-07-22 Amendment). Threaded only into the
 * deus-native runtime, mirroring `permissionRegistry`'s wiring exactly; when
 * omitted, `allow_always` behaves identically to `allow_once` (no
 * persistence) — today's pre-amendment behavior.
 */
export function createProductionRuntimeRegistry(
  deps: ContainerRuntimeDeps,
  activityBroadcaster: RuntimeActivityBroadcaster,
  permissionRegistry?: PendingPermissionRegistry,
  alwaysAllowGrants?: SessionAlwaysAllowGrants,
): RuntimeRegistry {
  const registry = initRuntimeRegistry();

  registry.register(createClaudeRuntime(deps));
  registry.register(createOpenAIRuntime(deps));
  registry.register(createLlamaCppRuntime(deps));
  registry.register(
    withRuntimeActivityBroadcast(
      createDeusNativeRuntime(deps, permissionRegistry, alwaysAllowGrants),
      activityBroadcaster,
    ),
  );

  return registry;
}
