/**
 * Container-side deus-native protocol-portability driver (LIA-423).
 *
 * SECURITY BOUNDARY: full broker-tool parity is licensed here ONLY because
 * every tool executes inside the existing container boundary. This does not
 * authorize widening the host adapter's SAFE_TOOL_NAMES in
 * src/agent-runtimes/tool-broker-langchain-adapter.ts. The two LangChain
 * adapters deliberately operate under different, non-transferable trust
 * boundaries.
 *
 * This createAgent instance binds tools derived from this package's broker
 * definitions and MCP bridge, PLUS exactly one non-broker tool (LIA-426/F4):
 * `load_skill`, a local, read-only instruction-pack resolver
 * (skill-context-loader.ts). It never executes skill code, never grants new
 * tools, and never binds a LangChain built-in shell, Python, retriever,
 * HTTP, or other native tool.
 */

import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import Anthropic from '@anthropic-ai/sdk';
import { ChatAnthropic } from '@langchain/anthropic';
import {
  AIMessage,
  BaseMessage,
  HumanMessage,
  type MessageContent,
} from '@langchain/core/messages';
import { tool, type StructuredToolInterface } from '@langchain/core/tools';
import { createAgent } from 'langchain';

import { loadRegisteredContextFiles } from './context-registry.js';
import { DoomLoopDetector, normalizeArgs } from './doom-loop-detector.js';
import { fetchMemoryContext } from './memory-retrieval-hook.js';
import {
  createSkillLoaderTool,
  loadRuntimeSkillRegistry,
} from './skill-context-loader.js';
import type {
  ContainerInput,
  ContainerOutput,
  RuntimeSession,
} from './openai-backend.js';
import {
  createOpenAIMcpToolBridge,
  executeBrokerTool,
  getOpenAIToolDefinitions,
  resolveGroupAttachmentPath,
  type OpenAIFunctionToolDefinition,
  type OpenAIMcpServerConfig,
  type OpenAIMcpToolBridge,
} from './tool-broker.js';

export interface DeusNativeContext {
  containerInput: ContainerInput;
  log: (message: string) => void;
  writeOutput: (output: ContainerOutput) => void;
  drainIpcInput: () => string[];
  waitForIpcMessage: () => Promise<string | null>;
  shouldClose: () => boolean;
}

export const DEUS_NATIVE_RECURSION_LIMIT = 25;
const COMPACT_KEEP_MESSAGES = 16;
const DEFAULT_MODEL = 'claude-opus-4-8';

function isControlGroup(containerInput: ContainerInput): boolean {
  return containerInput.isControlGroup ?? containerInput.isMain ?? false;
}

function discoverExtraSkillDirectories(): string[] {
  const extraBase = '/workspace/extra';
  if (!fs.existsSync(extraBase)) return [];
  try {
    return fs
      .readdirSync(extraBase, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(extraBase, entry.name));
  } catch {
    return [];
  }
}

function runtimeContext(
  containerInput: ContainerInput,
  log: (message: string) => void,
): {
  cwd: string;
  hasProject: boolean;
  systemInstructions: string;
  skillRegistry: ReturnType<typeof loadRuntimeSkillRegistry>;
} {
  const projectDir = '/workspace/project';
  let cwd = '/workspace/group';
  let hasProject = false;
  try {
    const stat = fs.statSync(projectDir);
    if (stat.isDirectory()) {
      const realProjectDir = fs.realpathSync(projectDir);
      if (
        realProjectDir.startsWith('/workspace/') &&
        fs.readdirSync(projectDir).some((entry) => !entry.startsWith('.'))
      ) {
        cwd = projectDir;
        hasProject = true;
      }
    }
  } catch {
    // No project mount — use group workspace.
  }

  // LIA-426/F4: one registry per container conversation, discovering skill
  // instruction packs from the same personal/project/extra roots
  // loadRegisteredContextFiles already reads AGENTS.md/CLAUDE.md from.
  const skillRegistry = loadRuntimeSkillRegistry({
    cwd,
    additionalDirectories: discoverExtraSkillDirectories(),
    log,
  });

  const systemInstructions = [
    'You are running inside the Deus backend-neutral deus-native container adapter.',
    'Preserve the same Deus user experience as the Claude backend: same tone, memory, privacy boundaries, chat commands, and long-term personal context.',
    'Use only the provided Deus broker and MCP tools. All filesystem and shell work remains inside the container sandbox.',
    `Primary working directory: ${cwd}`,
    ...loadRegisteredContextFiles({
      isControlGroup: isControlGroup(containerInput),
      hasProject,
    }),
    skillRegistry.catalogContext(),
    containerInput.projectHint || '',
  ]
    .filter(Boolean)
    .join('\n\n');

  return { cwd, hasProject, systemInstructions, skillRegistry };
}

function mcpServerConfigs(
  containerInput: ContainerInput,
): OpenAIMcpServerConfig[] {
  const dirname = path.dirname(fileURLToPath(import.meta.url));
  const configs: OpenAIMcpServerConfig[] = [
    {
      serverName: 'deus',
      command: 'node',
      args: [path.join(dirname, 'ipc-mcp-stdio.js')],
      env: {
        DEUS_CHAT_JID: containerInput.chatJid,
        DEUS_GROUP_FOLDER: containerInput.groupFolder,
        DEUS_IS_MAIN: isControlGroup(containerInput) ? '1' : '0',
      },
      required: true,
    },
  ];

  const projectDir = '/workspace/project';
  const gcalDistPath = path.join(projectDir, 'packages/mcp-gcal/dist/index.js');
  if (
    fs.existsSync(gcalDistPath) &&
    fs.existsSync(
      path.join(projectDir, 'integrations/gcal/credentials.json'),
    ) &&
    fs.existsSync(path.join(projectDir, 'integrations/gcal/tokens.json'))
  ) {
    configs.push({
      serverName: 'gcal',
      command: 'node',
      args: [gcalDistPath],
      env: {
        DEUS_PROJECT_ROOT: projectDir,
        LOG_LEVEL: process.env.LOG_LEVEL || 'info',
      },
      required: false,
    });
  }

  return configs;
}

export function parseAnthropicCustomHeaders(
  raw: string | undefined,
): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of raw?.split('\n') ?? []) {
    const separator = line.indexOf(':');
    if (separator <= 0) continue;
    const name = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (name && value) headers[name] = value;
  }
  return headers;
}

export function buildProxyRoutedModel(): ChatAnthropic {
  const baseURL = process.env.ANTHROPIC_BASE_URL;
  const proxyToken = process.env.DEUS_PROXY_TOKEN;
  if (!baseURL || !proxyToken) {
    throw new Error(
      'deus-native requires ANTHROPIC_BASE_URL and DEUS_PROXY_TOKEN credential-proxy routing',
    );
  }

  const customHeaders = {
    ...parseAnthropicCustomHeaders(process.env.ANTHROPIC_CUSTOM_HEADERS),
    'x-deus-proxy-token': proxyToken,
  };
  const apiKeyMode = Boolean(process.env.ANTHROPIC_API_KEY);

  return new ChatAnthropic({
    // DEUS_NATIVE_MODEL: tracking issue LIA-423 (this ticket).
    model: process.env.DEUS_NATIVE_MODEL || DEFAULT_MODEL,
    createClient: (options) =>
      apiKeyMode
        ? new Anthropic({
            baseURL: options.baseURL ?? baseURL,
            apiKey: 'placeholder',
            defaultHeaders: customHeaders,
          })
        : new Anthropic({
            baseURL: options.baseURL ?? baseURL,
            authToken: 'placeholder',
            apiKey: null,
            defaultHeaders: {
              'anthropic-beta': 'oauth-2025-04-20',
              ...customHeaders,
            },
          }),
  });
}

function toolExitCode(result: Record<string, unknown>): number {
  if (typeof result.exitCode === 'number') return result.exitCode;
  return result.ok === false ? 1 : 0;
}

export function brokerDerivedToolNames(
  mcpDefinitions: OpenAIFunctionToolDefinition[],
): Set<string> {
  return new Set(
    getOpenAIToolDefinitions(mcpDefinitions).map(
      (definition) => definition.name,
    ),
  );
}

export function buildBrokerDerivedTools(
  definitions: OpenAIFunctionToolDefinition[],
  mcpBridge: OpenAIMcpToolBridge,
  cwd: string,
  containerInput: ContainerInput,
  doomDetector: DoomLoopDetector,
): StructuredToolInterface[] {
  const expectedNames = new Set(
    definitions.map((definition) => definition.name),
  );
  if (expectedNames.size !== definitions.length) {
    throw new Error('Duplicate broker/MCP tool name in deus-native binding');
  }

  const tools = definitions.map((definition) =>
    tool(
      async (rawArgs) => {
        const args = rawArgs as Record<string, unknown>;
        let result =
          (await mcpBridge.execute(definition.name, args)) ?? undefined;
        if (!result) {
          try {
            result = await executeBrokerTool(definition.name, args, {
              cwd,
              containerInput,
            });
          } catch (error) {
            result = {
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            };
          }
        }

        const exitCode = toolExitCode(result);
        const detection = doomDetector.record({
          toolName: definition.name,
          normalizedArgs: normalizeArgs(definition.name, args),
          exitCode,
          succeeded: result.ok !== false && exitCode === 0,
        });
        return JSON.stringify(
          detection.detected
            ? { ...result, deus_loop_warning: detection.message }
            : result,
        );
      },
      {
        name: definition.name,
        description: definition.description,
        schema: definition.parameters,
      },
    ),
  );

  if (tools.some((boundTool) => !expectedNames.has(boundTool.name))) {
    throw new Error('Non-broker tool reached deus-native binding');
  }
  return tools;
}

function userMessage(
  prompt: string,
  attachments: ContainerInput['imageAttachments'],
): HumanMessage {
  const content: MessageContent = [{ type: 'text', text: prompt }];
  for (const attachment of attachments ?? []) {
    const attachmentPath = resolveGroupAttachmentPath(attachment.relativePath);
    try {
      const data = fs.readFileSync(attachmentPath).toString('base64');
      content.push({
        type: 'image_url',
        image_url: `data:${attachment.mediaType};base64,${data}`,
      });
    } catch {
      // Keep the text turn usable when an attachment disappears mid-run.
    }
  }
  return new HumanMessage({ content });
}

function assistantText(messages: BaseMessage[]): string | null {
  const assistant = [...messages]
    .reverse()
    .find((message) => AIMessage.isInstance(message));
  if (!assistant) return null;
  if (typeof assistant.content === 'string') return assistant.content || null;
  const text = assistant.content
    .map((block) =>
      typeof block === 'string'
        ? block
        : block.type === 'text' && typeof block.text === 'string'
          ? block.text
          : '',
    )
    .filter(Boolean)
    .join('\n');
  return text || null;
}

function sessionRef(
  sessionId: string,
  incoming: RuntimeSession | undefined,
): RuntimeSession {
  return {
    backend: 'deus-native',
    session_id: sessionId,
    ...(incoming?.resume_cursor
      ? { resume_cursor: incoming.resume_cursor }
      : {}),
    ...(incoming?.metadata_json
      ? { metadata_json: incoming.metadata_json }
      : {}),
  };
}

export async function runDeusNativeConversation(
  ctx: DeusNativeContext,
): Promise<void> {
  const {
    containerInput,
    log,
    writeOutput,
    drainIpcInput,
    waitForIpcMessage,
    shouldClose,
  } = ctx;

  // Belt-and-suspenders with host buildContainerArgs: a direct caller must not
  // bypass the Claude-only curated webhook profile.
  if (process.env.DEUS_TOOL_PROFILE === 'webhook') {
    writeOutput({
      status: 'error',
      result: null,
      error:
        "publicIngress requests require the 'claude' backend (reduced-privilege profile is claude-only); refusing deus-native before model or tool initialization",
    });
    return;
  }

  const incomingSession =
    containerInput.sessionRef?.backend === 'deus-native'
      ? containerInput.sessionRef
      : undefined;
  const sessionId =
    incomingSession?.session_id ||
    containerInput.sessionId ||
    `deus-native-${randomUUID()}`;
  const currentSessionRef = sessionRef(sessionId, incomingSession);
  const messages: BaseMessage[] = [];
  let mcpBridge: OpenAIMcpToolBridge | undefined;

  try {
    const { cwd, hasProject, systemInstructions, skillRegistry } =
      runtimeContext(containerInput, log);
    mcpBridge = await createOpenAIMcpToolBridge(
      mcpServerConfigs(containerInput).filter(
        (config) => config.serverName !== 'gcal' || hasProject,
      ),
      log,
    );
    const definitions = getOpenAIToolDefinitions(mcpBridge.definitions);
    const tools = [
      ...buildBrokerDerivedTools(
        definitions,
        mcpBridge,
        cwd,
        containerInput,
        new DoomLoopDetector(),
      ),
      // LIA-426/F4: the sole permitted non-broker tool — a local, read-only
      // instruction-pack resolver. Never executes code, never grants tools.
      createSkillLoaderTool(skillRegistry),
    ];
    const agent = createAgent({
      model: buildProxyRoutedModel(),
      tools,
      systemPrompt: systemInstructions,
    });

    // LIA-426/F4: kept UNPREFIXED (unlike the pre-F4 code, which prepended
    // the scheduled-task banner here) so /compact and direct skill
    // invocation can still match a scheduled task whose literal configured
    // body IS a command (e.g. a nightly "/compress" cron entry) — the
    // banner is prepended only when actually building the agent's input,
    // not when deciding what kind of turn this is. isScheduledTask is only
    // ever true for the very first turn (the loop breaks right after), so
    // this distinction never needs to persist across iterations.
    let prompt = containerInput.prompt;
    let isFirstTurn = true;
    const pending = drainIpcInput();
    if (pending.length > 0) prompt += `\n${pending.join('\n')}`;

    while (!shouldClose()) {
      const scheduledTaskBanner =
        isFirstTurn && containerInput.isScheduledTask
          ? '[SCHEDULED TASK - The following message was sent automatically and is not coming directly from the user or group.]'
          : '';
      isFirstTurn = false;

      if (prompt.trim() === '/compact') {
        if (messages.length > COMPACT_KEEP_MESSAGES) {
          messages.splice(0, messages.length - COMPACT_KEEP_MESSAGES);
        }
        writeOutput({
          status: 'success',
          result: 'Conversation compacted.',
          newSessionId: sessionId,
          newSessionRef: currentSessionRef,
        });
      } else {
        // LIA-426/F4: a direct /skill-name invocation is resolved BEFORE the
        // agent turn. A failure (missing/invalid/unsupported/not-user-
        // invocable) is a handled, actionable result — never a transport-
        // level error, which would make the host roll back the cursor and
        // retry the same bad command. Model-driven selection instead goes
        // through the load_skill tool bound above, mid-turn.
        const directSkill = skillRegistry.resolvePrompt(prompt);
        if (directSkill && !directSkill.ok) {
          writeOutput({
            status: 'success',
            result: directSkill.message,
            newSessionId: sessionId,
            newSessionRef: currentSessionRef,
          });
        } else {
          const memoryContext = await fetchMemoryContext(
            prompt,
            'container-deus-native',
          );
          const enrichedPrompt = [
            memoryContext,
            directSkill?.ok ? directSkill.contextBlock : '',
            scheduledTaskBanner,
            prompt,
          ]
            .filter(Boolean)
            .join('\n\n');
          const inputMessage = userMessage(
            enrichedPrompt,
            containerInput.imageAttachments,
          );
          const response = await agent.invoke(
            { messages: [...messages, inputMessage] },
            { recursionLimit: DEUS_NATIVE_RECURSION_LIMIT },
          );
          if (!response || !Array.isArray(response.messages)) {
            throw new Error('deus-native agent returned invalid message state');
          }
          messages.splice(0, messages.length, ...response.messages);
          writeOutput({
            status: 'success',
            result: assistantText(messages),
            newSessionId: sessionId,
            newSessionRef: currentSessionRef,
          });
        }
      }

      writeOutput({
        status: 'success',
        result: null,
        newSessionId: sessionId,
        newSessionRef: currentSessionRef,
      });

      if (containerInput.isScheduledTask || shouldClose()) break;
      const nextMessage = await waitForIpcMessage();
      if (nextMessage === null) break;
      prompt = nextMessage;
    }
  } catch (error) {
    writeOutput({
      status: 'error',
      result: null,
      error: error instanceof Error ? error.message : String(error),
      newSessionId: sessionId,
      newSessionRef: currentSessionRef,
    });
  } finally {
    await mcpBridge?.close().catch((error) => {
      log(
        `Failed to close deus-native MCP bridge: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }
}
