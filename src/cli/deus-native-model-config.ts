import fs from 'fs';
import path from 'path';

import { CONFIG_DIR } from '../config.js';
import { IS_WINDOWS } from '../platform.js';
import {
  parseNativeModelConfig,
  resolveEffectiveNativeModelConfig,
  resolveEffectiveRoleModel,
  validateNativeModelRef,
  validateNativeRole,
  type EffectiveNativeModelConfig,
  type NativeModelConfigV1,
  type NativeModelRef,
} from '../agent-runtimes/model-selection.js';

export function nativeModelConfigPath(): string {
  return path.join(CONFIG_DIR, 'native-models.json');
}

export function loadNativeModelConfig(
  filePath = nativeModelConfigPath(),
): NativeModelConfigV1 {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT')
      return { version: 1, roles: {} };
    throw err;
  }
  try {
    return parseNativeModelConfig(JSON.parse(raw));
  } catch (err) {
    if (err instanceof SyntaxError)
      throw new Error(
        `Malformed native model configuration at ${filePath}: ${err.message}`,
        { cause: err },
      );
    throw err;
  }
}

export function loadEffectiveNativeModelConfig(
  filePath = nativeModelConfigPath(),
): EffectiveNativeModelConfig {
  return resolveEffectiveNativeModelConfig(loadNativeModelConfig(filePath));
}

export function writeNativeModelConfig(
  config: NativeModelConfigV1,
  filePath = nativeModelConfigPath(),
): void {
  const validated = parseNativeModelConfig(config);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(validated, null, 2)}\n`, {
      mode: 0o600,
    });
    fs.renameSync(tmp, filePath);
    if (!IS_WINDOWS) fs.chmodSync(filePath, 0o600);
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* already renamed or absent */
    }
  }
}

export function setNativeModel(
  ref: NativeModelRef,
  role?: string,
  filePath = nativeModelConfigPath(),
): void {
  const validatedRef = validateNativeModelRef(ref);
  if (role !== undefined) validateNativeRole(role);
  const current = loadNativeModelConfig(filePath);
  const replacement: NativeModelConfigV1 =
    role === undefined
      ? { ...current, main: validatedRef }
      : { ...current, roles: { ...current.roles, [role]: validatedRef } };
  writeNativeModelConfig(replacement, filePath);
}

function formatRef(ref: NativeModelRef): string {
  return `${ref.provider}/${ref.model}`;
}

export function formatNativeModelConfig(
  config: NativeModelConfigV1,
  role?: string,
): string {
  const effective = resolveEffectiveNativeModelConfig(config);
  if (role !== undefined) {
    validateNativeRole(role);
    const configured = Object.hasOwn(config.roles, role);
    return `Role ${role}: ${formatRef(resolveEffectiveRoleModel(effective, role))} (${configured ? 'configured' : 'inherits main'})`;
  }
  const lines = [
    `Main: ${formatRef(effective.main)} (${config.main ? 'configured' : 'default'})`,
    'Roles:',
  ];
  const entries = Object.entries(config.roles).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  lines.push(
    ...(entries.length
      ? entries.map(
          ([name, ref]) => `  ${name}: ${formatRef(ref)} (configured)`,
        )
      : ['  (none configured)']),
  );
  lines.push(`Unconfigured roles inherit: ${formatRef(effective.main)}`);
  return lines.join('\n');
}
