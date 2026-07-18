/**
 * Backend identifiers accepted by the container agent-runner process itself.
 *
 * This is deliberately broader than tool-broker.ts's VALID_BACKENDS. The
 * latter is a user/agent-facing allowlist for selecting the backend of a new
 * scheduled task or registered group; widening it is outside LIA-423's scope.
 */
export const CONTAINER_DISPATCH_BACKENDS = [
  'claude',
  'openai',
  'llama-cpp',
  'deus-native',
] as const;

export type ContainerDispatchBackendId =
  (typeof CONTAINER_DISPATCH_BACKENDS)[number];

export function isContainerDispatchBackend(
  value: unknown,
): value is ContainerDispatchBackendId {
  return (
    typeof value === 'string' &&
    (CONTAINER_DISPATCH_BACKENDS as readonly string[]).includes(value)
  );
}
