import {
  RuntimeActivityBroadcaster,
  withRuntimeActivityBroadcast,
} from './activity-broadcaster.js';
import { createClaudeRuntime } from './claude-backend.js';
import type { ContainerRuntimeDeps } from './container-backend.js';
import { createDeusNativeRuntime } from './deus-native-backend.js';
import { createLlamaCppRuntime } from './llama-cpp-backend.js';
import { createOpenAIRuntime } from './openai-backend.js';
import { initRuntimeRegistry, type RuntimeRegistry } from './registry.js';

/**
 * Build the daemon's production runtime registry.
 *
 * LIA-423 deliberately does not register a ContainerRuntime for deus-native:
 * direct container-agent-runner dispatch is a protocol-portability proof,
 * while normal production resolution continues to use the host-native runtime.
 */
export function createProductionRuntimeRegistry(
  deps: ContainerRuntimeDeps,
  activityBroadcaster: RuntimeActivityBroadcaster,
): RuntimeRegistry {
  const registry = initRuntimeRegistry();

  registry.register(createClaudeRuntime(deps));
  registry.register(createOpenAIRuntime(deps));
  registry.register(createLlamaCppRuntime(deps));
  registry.register(
    withRuntimeActivityBroadcast(
      createDeusNativeRuntime(deps),
      activityBroadcaster,
    ),
  );

  return registry;
}
