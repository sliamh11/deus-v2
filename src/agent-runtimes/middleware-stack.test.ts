import { describe, it, expect, afterEach, vi } from 'vitest';
import { createAgent, tool, FakeToolCallingModel } from 'langchain';

import {
  CANONICAL_MIDDLEWARE_ORDER,
  buildMiddlewareStack,
  parseMiddlewareStackConfig,
  resolveMiddlewareStackConfig,
  type MiddlewareLayerName,
  type OrderMarker,
} from './middleware-stack.js';

/** Middleware instance names equal their layer names, so ordering
 *  assertions read directly against CANONICAL_MIDDLEWARE_ORDER. */
function layerNames(config = {}): string[] {
  return buildMiddlewareStack(config).middleware.map((m) => m.name);
}

describe('buildMiddlewareStack — ordering (AC1) and disablement (AC3)', () => {
  it('all layers enabled by default ({} config) in exactly the canonical order', () => {
    expect(layerNames({})).toEqual([
      'permissions',
      'wardens',
      'memory',
      'telemetry',
    ]);
    // The canonical array is the single source of truth being asserted.
    expect(layerNames({})).toEqual([...CANONICAL_MIDDLEWARE_ORDER]);
  });

  it.each([
    ['permissions', ['wardens', 'memory', 'telemetry']],
    ['wardens', ['permissions', 'memory', 'telemetry']],
    ['memory', ['permissions', 'wardens', 'telemetry']],
    ['telemetry', ['permissions', 'wardens', 'memory']],
  ] as const)(
    'disabling %s preserves the relative order of the remaining layers',
    (disabled, expected) => {
      expect(layerNames({ [disabled]: false })).toEqual(expected);
    },
  );

  it('disabling multiple layers preserves the relative order of the rest', () => {
    expect(layerNames({ permissions: false, memory: false })).toEqual([
      'wardens',
      'telemetry',
    ]);
  });

  it('disabling all layers returns an empty middleware array', () => {
    expect(
      layerNames({
        permissions: false,
        wardens: false,
        memory: false,
        telemetry: false,
      }),
    ).toEqual([]);
  });

  it('a disabled layer contributes no log; enabled layers keep theirs', () => {
    const { logs } = buildMiddlewareStack({ wardens: false });
    expect(logs.wardens).toBeUndefined();
    expect(logs.permissions).toEqual([]);
    expect(logs.memory).toEqual([]);
    expect(logs.telemetry).toEqual([]);
  });
});

describe('buildMiddlewareStack — independent per-layer toggles (AC2)', () => {
  it.each(CANONICAL_MIDDLEWARE_ORDER.map((l) => [l] as const))(
    'the %s toggle controls only its own layer',
    (layer: MiddlewareLayerName) => {
      const names = layerNames({ [layer]: false });
      // The toggled layer is gone...
      expect(names).not.toContain(layer);
      // ...and EVERY other layer is untouched, in canonical order.
      expect(names).toEqual(
        CANONICAL_MIDDLEWARE_ORDER.filter((l) => l !== layer),
      );
    },
  );

  it('an explicit true is the same as an absent key (enabled)', () => {
    expect(
      layerNames({
        permissions: true,
        wardens: true,
        memory: true,
        telemetry: true,
      }),
    ).toEqual([...CANONICAL_MIDDLEWARE_ORDER]);
  });
});

// ── AC4: entry/exit ordering proof over a REAL createAgent turn ──────────
//
// beforeAgent/afterAgent is the one hook type that wraps the entire turn
// exactly once per layer (ReactAgent.js chains beforeAgent nodes in forward
// array order and afterAgent nodes in reverse), so the shared orderMarkers
// array records the genuine cross-layer onion. The scripted model emits a
// real tool call on its first cycle so every layer's SUBSTANTIVE hook
// (wrapToolCall / beforeModel+afterModel / wrapModelCall) also fires at
// least once — confirming the markers and the substantive logs are
// consistent with each other. FakeToolCallingModel is langchain's own
// createAgent test model (real BaseChatModel with working bindTools) —
// hermetic, no network (same precedent as lia399's test).

const ECHO_TOOL = tool(
  async (args: { value: string }) => `echo:${args.value}`,
  {
    name: 'echo_tool',
    description: 'Echoes the provided value back.',
    schema: {
      type: 'object',
      properties: { value: { type: 'string' } },
      required: ['value'],
      additionalProperties: false,
    },
  },
);

function scriptedModel(): FakeToolCallingModel {
  // First model cycle: request one echo_tool call. Second cycle: plain
  // final answer (empty toolCalls entry), ending the ReAct loop.
  return new FakeToolCallingModel({
    toolCalls: [
      [{ name: 'echo_tool', args: { value: 'ping' }, id: 'call_1' }],
      [],
    ],
  });
}

describe('middleware entry/exit order across a real agent turn (AC4)', () => {
  it('records the onion order: enter 0->3, exit 3->0, with every substantive hook also firing', async () => {
    const orderMarkers: OrderMarker[] = [];
    const { middleware, logs } = buildMiddlewareStack({}, { orderMarkers });

    const agent = createAgent({
      model: scriptedModel(),
      tools: [ECHO_TOOL],
      middleware,
    });
    await agent.invoke({
      messages: [{ role: 'user', content: 'call the echo tool once' }],
    });

    // The empirical proof of the array-order-to-wrap-order mapping:
    // index 0 (permissions) enters FIRST and exits LAST.
    expect(orderMarkers).toEqual([
      { layer: 'permissions', phase: 'enter' },
      { layer: 'wardens', phase: 'enter' },
      { layer: 'memory', phase: 'enter' },
      { layer: 'telemetry', phase: 'enter' },
      { layer: 'telemetry', phase: 'exit' },
      { layer: 'memory', phase: 'exit' },
      { layer: 'wardens', phase: 'exit' },
      { layer: 'permissions', phase: 'exit' },
    ]);

    // Substantive hooks fired consistently with the scripted turn:
    // one tool call seen by BOTH wrapToolCall layers...
    expect(logs.permissions?.map((r) => r.toolName)).toEqual(['echo_tool']);
    expect(logs.wardens?.map((r) => r.toolName)).toEqual(['echo_tool']);
    // ...two model cycles (tool-call turn + final turn) seen by memory's
    // beforeModel/afterModel and telemetry's wrapModelCall.
    expect(logs.memory?.filter((r) => r.hook === 'beforeModel')).toHaveLength(
      2,
    );
    expect(logs.memory?.filter((r) => r.hook === 'afterModel')).toHaveLength(2);
    expect(logs.telemetry?.map((r) => r.requestIndex)).toEqual([0, 1]);
    expect(logs.telemetry?.[0]?.providerClass).toBe('FakeToolCallingModel');
  });

  it('a disabled layer drops out of the recorded order without disturbing the rest (AC3, live)', async () => {
    const orderMarkers: OrderMarker[] = [];
    const { middleware, logs } = buildMiddlewareStack(
      { wardens: false },
      { orderMarkers },
    );

    const agent = createAgent({
      model: scriptedModel(),
      tools: [ECHO_TOOL],
      middleware,
    });
    await agent.invoke({
      messages: [{ role: 'user', content: 'call the echo tool once' }],
    });

    expect(orderMarkers).toEqual([
      { layer: 'permissions', phase: 'enter' },
      { layer: 'memory', phase: 'enter' },
      { layer: 'telemetry', phase: 'enter' },
      { layer: 'telemetry', phase: 'exit' },
      { layer: 'memory', phase: 'exit' },
      { layer: 'permissions', phase: 'exit' },
    ]);
    expect(logs.wardens).toBeUndefined();
    // The remaining wrapToolCall layer still saw the tool call.
    expect(logs.permissions?.map((r) => r.toolName)).toEqual(['echo_tool']);
  });
});

describe('parseMiddlewareStackConfig — invalid config rejected or normalized deterministically (AC5)', () => {
  it('drops unknown keys and keeps known ones (normalized, not rejected)', () => {
    expect(
      parseMiddlewareStackConfig({ wardens: false, futureLayer: true }),
    ).toEqual({ wardens: false });
  });

  it('returns {} (all enabled) for an empty object', () => {
    expect(parseMiddlewareStackConfig({})).toEqual({});
  });

  it('throws a descriptive error on a non-boolean value for a known key', () => {
    expect(() => parseMiddlewareStackConfig({ wardens: 'false' })).toThrow(
      'layer "wardens" must be a boolean, got string',
    );
  });

  it.each([
    ['null', null],
    ['array', []],
    ['string', 'wardens'],
    ['number', 42],
  ] as const)('throws on a non-object config (%s)', (_label, raw) => {
    expect(() => parseMiddlewareStackConfig(raw)).toThrow(
      'expected a plain object',
    );
  });
});

describe('resolveMiddlewareStackConfig — DEUS_NATIVE_MIDDLEWARE_CONFIG env var', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('defaults to {} (all enabled) when unset', () => {
    vi.stubEnv('DEUS_NATIVE_MIDDLEWARE_CONFIG', '');
    expect(resolveMiddlewareStackConfig()).toEqual({});
  });

  it('defaults to {} on a malformed JSON string (env typo must not crash the runtime)', () => {
    vi.stubEnv('DEUS_NATIVE_MIDDLEWARE_CONFIG', '{wardens: false'); // not JSON
    expect(resolveMiddlewareStackConfig()).toEqual({});
  });

  it('parses a valid JSON object through the strict validator', () => {
    vi.stubEnv(
      'DEUS_NATIVE_MIDDLEWARE_CONFIG',
      '{"wardens":false,"unknown":true}',
    );
    expect(resolveMiddlewareStackConfig()).toEqual({ wardens: false });
  });

  it('stays strict on valid JSON that is a malformed config OBJECT', () => {
    // Deliberate boundary (see resolveMiddlewareStackConfig's doc comment):
    // lenient only for the JSON-STRING failure mode, not for a genuinely
    // malformed parsed object.
    vi.stubEnv('DEUS_NATIVE_MIDDLEWARE_CONFIG', '{"wardens":"nope"}');
    expect(() => resolveMiddlewareStackConfig()).toThrow(
      'layer "wardens" must be a boolean',
    );
  });
});
