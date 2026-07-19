import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ClaudeCliSessionPool } from '../../src/agent-runtimes/cli-subprocess/claude-cli-session-pool.js';
import {
  isSystemInitEvent,
  isAssistantEvent,
  isUserEvent,
  extractToolUseBlocks,
  extractToolResultBlocks,
  extractToolResultText,
} from '../../src/agent-runtimes/cli-subprocess/stream-json-protocol.js';

const spikeDirectory = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(spikeDirectory, '../..');
const mcpServerScriptPath = path.resolve(
  repoRoot,
  'src/agent-runtimes/cli-subprocess/nested-dispatch-mcp-server.ts',
);
const mcpServerName = 'deus_lia454_debug';

async function main() {
  const pool = new ClaudeCliSessionPool({
    maxProcesses: 1,
    idleTimeoutMs: 60_000,
    terminationGraceMs: 3_000,
    onEvent: () => {},
  });

  await pool.createConversation('debug-conv', {
    scratchDir: path.join(repoRoot, '.claude', 'worktrees', 'lia454-debug'),
    mcpServerName,
    mcpServerScriptPath,
    mcpServerEnv: {
      DEUS_NESTED_DISPATCH_CONTEXT: JSON.stringify({
        permissionProfile: 'default',
        wardenCwd: repoRoot,
        toolBrokerContext: { cwd: repoRoot },
        allowedWebFetchHosts: ['example.com'],
      }),
    },
    repoRoot,
    allowedTool: `mcp__${mcpServerName}__web_search,mcp__${mcpServerName}__web_fetch`,
  });

  const turnResult = await pool.sendTurn(
    'debug-conv',
    `Call the tool named exactly "mcp__${mcpServerName}__web_fetch" with argument {"url": "https://example.com"}.`,
  );

  for (const event of turnResult.events) {
    if (isSystemInitEvent(event)) {
      console.log(
        'SYSTEM INIT mcp_servers:',
        JSON.stringify(event.mcp_servers, null, 2),
      );
      console.log(
        'SYSTEM INIT tools:',
        JSON.stringify(event['tools'], null, 2),
      );
    }
    if (isAssistantEvent(event)) {
      const toolUses = extractToolUseBlocks(event);
      if (toolUses.length > 0) {
        console.log('ASSISTANT tool_use:', JSON.stringify(toolUses, null, 2));
      }
    }
    if (isUserEvent(event)) {
      const toolResults = extractToolResultBlocks(event);
      for (const tr of toolResults) {
        console.log(
          'USER tool_result is_error:',
          tr.is_error,
          'text:',
          extractToolResultText(tr).slice(0, 200),
        );
      }
    }
  }

  console.log('FINAL RESULT:', turnResult.result.result);
  await pool.terminate('debug-conv');
}

main().catch((err) => {
  console.error('FAILED:', err);
  process.exitCode = 1;
});
