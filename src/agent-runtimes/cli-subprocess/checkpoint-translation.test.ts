/**
 * LIA-454 EP-002 step 4: checkpoint-translation.ts tests.
 *
 * `persistCliCheckpoint`'s tests use a REAL temporary `SqliteSaver` (never
 * mocked) and a REAL `createAgent`/`FakeToolCallingModel` resume — a mocked
 * saver or graph would make the "does LangGraph actually accept this row"
 * question meaningless, matching this repo's own established precedent
 * (`deus-native-checkpointer-integration.test.ts`'s own doc comment).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';
import { createAgent, tool, FakeToolCallingModel } from 'langchain';
import { HumanMessage, AIMessage, ToolMessage } from '@langchain/core/messages';
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';

import {
  CliTurnTranslationError,
  persistCliCheckpoint,
  stripMcpToolPrefix,
  translateCliTurnResult,
} from './checkpoint-translation.js';
import type { StreamJsonEvent } from './stream-json-protocol.js';

// ── translateCliTurnResult (pure) ───────────────────────────────────────────

const MCP_SERVER_NAME = 'deus_lia454_parent';
const REGISTERED_TOOLS = ['web_search', 'web_fetch', 'dispatch_nested_agent'];

function assistantTextEvent(text: string, id = 'msg_1'): StreamJsonEvent {
  return {
    type: 'assistant',
    session_id: 's1',
    parent_tool_use_id: null,
    message: {
      role: 'assistant',
      id,
      model: 'claude-sonnet-5',
      content: [{ type: 'text', text }],
      usage: { input_tokens: 10, output_tokens: 5 },
    },
  };
}

function assistantToolUseEvent(
  toolUseId: string,
  toolName: string,
  id = 'msg_1',
): StreamJsonEvent {
  return {
    type: 'assistant',
    session_id: 's1',
    parent_tool_use_id: null,
    message: {
      role: 'assistant',
      id,
      model: 'claude-sonnet-5',
      content: [
        {
          type: 'tool_use',
          id: toolUseId,
          name: `mcp__${MCP_SERVER_NAME}__${toolName}`,
          input: { query: 'x' },
        },
      ],
    },
  };
}

function userToolResultEvent(
  toolUseId: string,
  text: string,
  isError = false,
): StreamJsonEvent {
  return {
    type: 'user',
    session_id: 's1',
    parent_tool_use_id: null,
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: toolUseId,
          content: [{ type: 'text', text }],
          ...(isError ? { is_error: true } : {}),
        },
      ],
    },
  };
}

function resultEvent(text?: string): StreamJsonEvent {
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    session_id: 's1',
    ...(text !== undefined ? { result: text } : {}),
  };
}

describe('stripMcpToolPrefix', () => {
  it('strips the exact configured prefix and validates against the catalog', () => {
    expect(
      stripMcpToolPrefix(
        `mcp__${MCP_SERVER_NAME}__web_search`,
        MCP_SERVER_NAME,
        REGISTERED_TOOLS,
      ),
    ).toBe('web_search');
  });

  it('throws on a name missing the expected prefix', () => {
    expect(() =>
      stripMcpToolPrefix('web_search', MCP_SERVER_NAME, REGISTERED_TOOLS),
    ).toThrow(CliTurnTranslationError);
  });

  it('throws on an unregistered tool name, even with the right prefix (unaudited name protection)', () => {
    expect(() =>
      stripMcpToolPrefix(
        `mcp__${MCP_SERVER_NAME}__shell_exec`,
        MCP_SERVER_NAME,
        REGISTERED_TOOLS,
      ),
    ).toThrow(/not in the registered parent tool catalog/);
  });
});

describe('translateCliTurnResult', () => {
  const baseOptions = {
    currentTurnMessageId: 'human-turn-1',
    prompt: 'hello',
    turnEvents: [] as StreamJsonEvent[],
    mcpServerName: MCP_SERVER_NAME,
    registeredToolNames: REGISTERED_TOOLS,
    priorMessages: [] as HumanMessage[],
  };

  it('produces a HumanMessage for the current turn, then one AIMessage per assistant cycle', () => {
    const result = translateCliTurnResult({
      ...baseOptions,
      turnEvents: [assistantTextEvent('hi there'), resultEvent('hi there')],
    });
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0]).toBeInstanceOf(HumanMessage);
    expect(result.messages[0].id).toBe('human-turn-1');
    expect(result.messages[1]).toBeInstanceOf(AIMessage);
    expect(result.messages[1].content).toBe('hi there');
    expect(result.finalAssistantText).toBe('hi there');
    expect(result.model).toBe('claude-sonnet-5');
  });

  it('inserts the recalled-memory HumanMessage after the user message, matching middleware-stack.ts', () => {
    const result = translateCliTurnResult({
      ...baseOptions,
      recalledMemoryContext: 'recalled: user likes cats',
      turnEvents: [assistantTextEvent('ok')],
    });
    expect(result.messages[0]).toBeInstanceOf(HumanMessage);
    expect(result.messages[0].id).toBe('human-turn-1');
    expect(result.messages[1]).toBeInstanceOf(HumanMessage);
    expect(result.messages[1].content).toBe('recalled: user likes cats');
    expect(result.messages[2]).toBeInstanceOf(AIMessage);
  });

  it('translates a tool_use/tool_result cycle into a paired AIMessage.tool_calls + ToolMessage, with the MCP prefix stripped to the canonical tool name', () => {
    const result = translateCliTurnResult({
      ...baseOptions,
      turnEvents: [
        assistantToolUseEvent('tc-1', 'web_search'),
        userToolResultEvent('tc-1', 'search results here'),
        assistantTextEvent('done', 'msg_2'),
        resultEvent('done'),
      ],
    });
    const aiWithToolCall = result.messages.find(
      (m) => m instanceof AIMessage && (m.tool_calls?.length ?? 0) > 0,
    ) as AIMessage;
    expect(aiWithToolCall.tool_calls).toEqual([
      { id: 'tc-1', name: 'web_search', args: { query: 'x' } },
    ]);
    const toolMessage = result.messages.find(
      (m) => m instanceof ToolMessage,
    ) as ToolMessage;
    expect(toolMessage.tool_call_id).toBe('tc-1');
    expect(toolMessage.content).toBe('search results here');
    expect(toolMessage.status).toBe('success');
    expect(result.toolCalls).toEqual([
      { id: 'tc-1', name: 'web_search', input: { query: 'x' } },
    ]);
  });

  it('marks a ToolMessage as status:"error" for an is_error:true tool_result', () => {
    const result = translateCliTurnResult({
      ...baseOptions,
      turnEvents: [
        assistantToolUseEvent('tc-1', 'dispatch_nested_agent'),
        userToolResultEvent('tc-1', 'permission_denied: ...', true),
      ],
    });
    const toolMessage = result.messages.find(
      (m) => m instanceof ToolMessage,
    ) as ToolMessage;
    expect(toolMessage.status).toBe('error');
  });

  it('throws CliTurnTranslationError on an unaudited tool name rather than silently translating it', () => {
    expect(() =>
      translateCliTurnResult({
        ...baseOptions,
        turnEvents: [assistantToolUseEvent('tc-1', 'shell_exec')],
      }),
    ).toThrow(CliTurnTranslationError);
  });

  it('uses the terminal result.result as a validated fallback ONLY when no assistant text block exists (never a duplicate message)', () => {
    const result = translateCliTurnResult({
      ...baseOptions,
      turnEvents: [
        assistantToolUseEvent('tc-1', 'web_search'),
        userToolResultEvent('tc-1', 'ok'),
        resultEvent('fallback text'),
      ],
    });
    expect(result.finalAssistantText).toBe('fallback text');
    // No extra AIMessage was synthesized for the fallback — only the one
    // real AIMessage (the tool_use cycle) plus the ToolMessage.
    expect(result.messages.filter((m) => m instanceof AIMessage)).toHaveLength(
      1,
    );
  });

  it('repairs an assistant message ID that collides with a prior checkpoint message ID (lifecycle-events.ts contract), keeping the real ID otherwise', () => {
    const priorMessages = [
      new HumanMessage({ id: 'collide-me', content: 'old turn' }),
    ];
    const result = translateCliTurnResult({
      ...baseOptions,
      priorMessages,
      turnEvents: [assistantTextEvent('hi', 'collide-me')],
    });
    expect(result.messages[1].id).not.toBe('collide-me');
    expect(result.messages[1].id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it('keeps the real provider ID when there is no collision', () => {
    const result = translateCliTurnResult({
      ...baseOptions,
      turnEvents: [assistantTextEvent('hi', 'msg_unique')],
    });
    expect(result.messages[1].id).toBe('msg_unique');
  });

  it('never fabricates usage_metadata when no assistant event reported usage', () => {
    const noUsageEvent: StreamJsonEvent = {
      type: 'assistant',
      session_id: 's1',
      parent_tool_use_id: null,
      message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
    };
    const result = translateCliTurnResult({
      ...baseOptions,
      turnEvents: [noUsageEvent],
    });
    expect(result.usageEvents).toEqual([]);
    expect((result.messages[1] as AIMessage).usage_metadata).toBeUndefined();
  });
});

// ── persistCliCheckpoint (real SqliteSaver + real createAgent resume) ──────

function tempSaver(): { saver: SqliteSaver; dbPath: string; dir: string } {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'lia454-checkpoint-bridge-'),
  );
  const dbPath = path.join(dir, 'checkpoints.db');
  return { saver: SqliteSaver.fromConnString(dbPath), dbPath, dir };
}

const echoTool = tool(async (args: { value: string }) => `echo:${args.value}`, {
  name: 'echo_tool',
  description: 'Echoes the provided value back.',
  schema: {
    type: 'object',
    properties: { value: { type: 'string' } },
    required: ['value'],
    additionalProperties: false,
  },
});

describe('persistCliCheckpoint', () => {
  it('writes a real new-thread checkpoint whose tuple is readable back with the right shape/metadata', async () => {
    const { saver, dir } = tempSaver();
    try {
      const threadId = crypto.randomUUID();
      const newMessages = [
        new HumanMessage({ id: 'h1', content: 'hi' }),
        new AIMessage({ id: 'a1', content: 'hello' }),
      ];

      await persistCliCheckpoint({
        saver,
        threadId,
        priorTuple: undefined,
        newMessages,
      });

      const tuple = await saver.getTuple({
        configurable: { thread_id: threadId },
      });
      expect(tuple).toBeDefined();
      expect(tuple!.checkpoint.channel_values['messages']).toEqual(newMessages);
      expect(tuple!.metadata).toMatchObject({
        source: 'update',
        step: 0,
        parents: {},
      });
      // Pin the actual bumped integer (BaseCheckpointSaver.getNextVersion's
      // real default: undefined -> 1) rather than merely "is defined" — this
      // locks the version-advancement contract the module is built around.
      expect(tuple!.checkpoint.channel_versions['messages']).toBe(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a second turn forms a real parent-checkpoint chain and accumulates messages', async () => {
    const { saver, dir } = tempSaver();
    try {
      const threadId = crypto.randomUUID();
      await persistCliCheckpoint({
        saver,
        threadId,
        priorTuple: undefined,
        newMessages: [new HumanMessage({ id: 'h1', content: 'turn 1' })],
      });
      const afterTurn1 = await saver.getTuple({
        configurable: { thread_id: threadId },
      });

      await persistCliCheckpoint({
        saver,
        threadId,
        priorTuple: afterTurn1,
        newMessages: [new HumanMessage({ id: 'h2', content: 'turn 2' })],
      });
      const afterTurn2 = await saver.getTuple({
        configurable: { thread_id: threadId },
      });

      expect(afterTurn2!.checkpoint.channel_values['messages']).toHaveLength(2);
      expect(afterTurn2!.metadata?.step).toBe(1);
      // Version bump: 1 (turn 1) -> 2 (turn 2), the real getNextVersion
      // increment — not just "a version exists".
      expect(afterTurn1!.checkpoint.channel_versions['messages']).toBe(1);
      expect(afterTurn2!.checkpoint.channel_versions['messages']).toBe(2);
      expect(afterTurn2!.parentConfig?.configurable?.checkpoint_id).toBe(
        afterTurn1!.checkpoint.id,
      );
      expect(afterTurn2!.checkpoint.id).not.toBe(afterTurn1!.checkpoint.id);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses to write when the latest tuple has drifted from the expected parent (lost-update guard)', async () => {
    const { saver, dir } = tempSaver();
    try {
      const threadId = crypto.randomUUID();
      await persistCliCheckpoint({
        saver,
        threadId,
        priorTuple: undefined,
        newMessages: [new HumanMessage({ id: 'h1', content: 'turn 1' })],
      });
      const staleTuple = await saver.getTuple({
        configurable: { thread_id: threadId },
      });

      // Simulate a second, uncoordinated writer landing a turn in between —
      // exactly the race the thread-turn lease (step 9) exists to prevent.
      await persistCliCheckpoint({
        saver,
        threadId,
        priorTuple: staleTuple,
        newMessages: [
          new HumanMessage({ id: 'h2', content: 'concurrent turn' }),
        ],
      });

      // Now retry with the ORIGINAL (now-stale) tuple as the expected parent.
      await expect(
        persistCliCheckpoint({
          saver,
          threadId,
          priorTuple: staleTuple,
          newMessages: [new HumanMessage({ id: 'h3', content: 'lost update' })],
        }),
      ).rejects.toThrow(/stale parent checkpoint/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a real LangGraph createAgent can resume a CLI-authored checkpoint and see its messages/tool-call history', async () => {
    const { saver, dir } = tempSaver();
    try {
      const threadId = crypto.randomUUID();

      // Simulate a real CLI turn: a tool_use/tool_result cycle, translated
      // and persisted exactly as parent-turn-runner.ts (step 10) will.
      const translated = translateCliTurnResult({
        currentTurnMessageId: 'h1',
        prompt: 'call echo_tool with value=ping',
        turnEvents: [
          assistantToolUseEvent('tc-1', 'web_search'),
          userToolResultEvent('tc-1', 'search done'),
          assistantTextEvent('I searched for you.', 'msg-final'),
          resultEvent('I searched for you.'),
        ],
        mcpServerName: MCP_SERVER_NAME,
        registeredToolNames: REGISTERED_TOOLS,
        priorMessages: [],
      });

      await persistCliCheckpoint({
        saver,
        threadId,
        priorTuple: undefined,
        newMessages: translated.messages,
      });

      // A REAL createAgent, REAL checkpointer, scripted model — resumes the
      // thread and adds ONE more human turn, proving the CLI-authored
      // checkpoint is genuinely LangGraph-compatible, not just a valid-
      // looking SQLite row.
      const model = new FakeToolCallingModel({ toolCalls: [[]] });
      const agent = createAgent({
        model,
        tools: [echoTool],
        checkpointer: saver,
      });
      const followUpId = crypto.randomUUID();
      const result = await agent.invoke(
        {
          messages: [new HumanMessage({ id: followUpId, content: 'thanks!' })],
        },
        { configurable: { thread_id: threadId } },
      );

      // Exact count AND order — not just "contains" — so a duplication or
      // reordering bug (e.g. a versions_seen regression double-processing a
      // channel) would actually fail this test. Positions 3 and 6 have
      // LangChain-auto-generated ids (no explicit id was set on the
      // ToolMessage or on FakeToolCallingModel's own generated answer).
      const ids = result.messages.map((m) => m.id);
      expect(ids).toEqual([
        'h1',
        'msg_1',
        expect.any(String), // ToolMessage (tc-1's result)
        'msg-final',
        followUpId,
        expect.any(String), // FakeToolCallingModel's follow-up answer
      ]);
      expect(result.messages).toHaveLength(6);
      expect(
        result.messages.some(
          (m) => m instanceof ToolMessage && m.tool_call_id === 'tc-1',
        ),
      ).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a raw-HTTP-style createAgent turn can extend a thread that started with a CLI-authored checkpoint, then a CLI turn can resume THAT (mixed-transport round trip)', async () => {
    const { saver, dir } = tempSaver();
    try {
      const threadId = crypto.randomUUID();

      // Turn 1: CLI-authored.
      const translated1 = translateCliTurnResult({
        currentTurnMessageId: 'h1',
        prompt: 'first turn',
        turnEvents: [assistantTextEvent('first answer', 'a1')],
        mcpServerName: MCP_SERVER_NAME,
        registeredToolNames: REGISTERED_TOOLS,
        priorMessages: [],
      });
      await persistCliCheckpoint({
        saver,
        threadId,
        priorTuple: undefined,
        newMessages: translated1.messages,
      });

      // Turn 2: a real graph-authored (raw-HTTP-style) turn extends it.
      const model = new FakeToolCallingModel({ toolCalls: [[]] });
      const agent = createAgent({ model, tools: [], checkpointer: saver });
      await agent.invoke(
        { messages: [new HumanMessage({ id: 'h2', content: 'second turn' })] },
        { configurable: { thread_id: threadId } },
      );

      // Turn 3: a CLI-authored turn resumes the graph-authored state.
      const afterTurn2 = await saver.getTuple({
        configurable: { thread_id: threadId },
      });
      const priorMessages = afterTurn2!.checkpoint.channel_values[
        'messages'
      ] as InstanceType<typeof HumanMessage>[];
      const translated3 = translateCliTurnResult({
        currentTurnMessageId: 'h3',
        prompt: 'third turn',
        turnEvents: [assistantTextEvent('third answer', 'a3')],
        mcpServerName: MCP_SERVER_NAME,
        registeredToolNames: REGISTERED_TOOLS,
        priorMessages,
      });
      await persistCliCheckpoint({
        saver,
        threadId,
        priorTuple: afterTurn2,
        newMessages: translated3.messages,
      });

      const finalTuple = await saver.getTuple({
        configurable: { thread_id: threadId },
      });
      const finalIds = (
        finalTuple!.checkpoint.channel_values['messages'] as Array<{
          id?: string;
        }>
      ).map((m) => m.id);
      expect(finalIds).toEqual(
        expect.arrayContaining(['h1', 'a1', 'h2', 'h3', 'a3']),
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
