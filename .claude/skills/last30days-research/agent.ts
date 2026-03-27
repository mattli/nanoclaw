/**
 * last30days Research - MCP Tool Definitions (Agent/Container Side)
 *
 * Exposes a research_topics tool to container agents.
 * The host-side implementation runs the Python scripts via IPC.
 *
 * Note: This file is compiled in the container, not on the host.
 * The @ts-ignore is needed because the SDK is only available in the container.
 */

// @ts-ignore - SDK available in container environment only
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';

// IPC directories (inside container)
const IPC_DIR = '/workspace/ipc';
const TASKS_DIR = path.join(IPC_DIR, 'tasks');
const RESULTS_DIR = path.join(IPC_DIR, 'last30days_results');

function writeIpcFile(dir: string, data: object): string {
  fs.mkdirSync(dir, { recursive: true });
  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = path.join(dir, filename);
  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filepath);
  return filename;
}

async function waitForResult(requestId: string, maxWait = 660000): Promise<{ success: boolean; message: string }> {
  const resultFile = path.join(RESULTS_DIR, `${requestId}.json`);
  const pollInterval = 2000;
  let elapsed = 0;

  while (elapsed < maxWait) {
    if (fs.existsSync(resultFile)) {
      try {
        const result = JSON.parse(fs.readFileSync(resultFile, 'utf-8'));
        fs.unlinkSync(resultFile);
        return result;
      } catch (err) {
        return { success: false, message: `Failed to read result: ${err}` };
      }
    }
    await new Promise(resolve => setTimeout(resolve, pollInterval));
    elapsed += pollInterval;
  }

  return { success: false, message: 'Research request timed out (11 minutes)' };
}

export interface SkillToolsContext {
  groupFolder: string;
  isMain: boolean;
}

/**
 * Create last30days research MCP tools
 */
export function createLast30DaysTools(ctx: SkillToolsContext) {
  const { groupFolder } = ctx;

  return [
    tool(
      'research_topics',
      `Run last30days research on one or more topics using Reddit and X as sources.
Returns structured findings with key insights, problem validation, and engagement stats.
Topics are separated by ||| (triple pipe) for multiple topics.
Use --search x to restrict to X only, --search reddit for Reddit only.
Use --quick for faster results or --deep for comprehensive results.`,
      {
        topics: z.string().describe('One or more topics separated by ||| (e.g., "AI video tools ||| browser automation")'),
        flags: z.string().optional().describe('Optional flags: --search x, --search reddit, --quick, --deep')
      },
      async (args: { topics: string; flags?: string }) => {
        const requestId = `l30d-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        writeIpcFile(TASKS_DIR, {
          type: 'last30days_research',
          requestId,
          topics: args.topics,
          flags: args.flags || '',
          groupFolder,
          timestamp: new Date().toISOString()
        });

        const result = await waitForResult(requestId);
        return {
          content: [{ type: 'text', text: result.message }],
          isError: !result.success
        };
      }
    )
  ];
}
