/**
 * last30days Research IPC Handler
 *
 * Handles last30days_* IPC messages from container agents.
 * Runs the Python research scripts on the host where API keys and
 * Bird CLI tokens are available.
 */

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import pino from 'pino';

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: { target: 'pino-pretty', options: { colorize: true } }
});

interface SkillResult {
  success: boolean;
  message: string;
}

// Locate the last30days script
function findScriptRoot(): string | null {
  const candidates = [
    path.join(os.homedir(), '.claude', 'plugins', 'marketplaces', 'last30days-skill'),
    path.join(os.homedir(), '.claude', 'skills', 'last30days'),
    path.join(os.homedir(), '.agents', 'skills', 'last30days'),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'scripts', 'last30days.py'))) {
      return dir;
    }
  }
  return null;
}

// Load env vars from .env file (for API keys)
function loadEnvFile(): Record<string, string> {
  const envPath = path.join(process.cwd(), '.env');
  const vars: Record<string, string> = {};
  if (!fs.existsSync(envPath)) return vars;
  const lines = fs.readFileSync(envPath, 'utf-8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx < 0) continue;
    vars[trimmed.slice(0, eqIdx)] = trimmed.slice(eqIdx + 1);
  }
  return vars;
}

// Run the last30days Python script for a single topic
async function runResearch(topic: string, flags: string): Promise<SkillResult> {
  const skillRoot = findScriptRoot();
  if (!skillRoot) {
    return { success: false, message: 'Could not find last30days scripts. Is the plugin installed?' };
  }

  const scriptPath = path.join(skillRoot, 'scripts', 'last30days.py');
  const saveDir = path.join(os.homedir(), 'Documents', 'Last30Days');
  fs.mkdirSync(saveDir, { recursive: true });

  // Build args
  const args = [
    scriptPath,
    topic,
    '--emit=compact',
    '--no-native-web',
    `--save-dir=${saveDir}`,
    '--search', 'reddit,x',
    '--timeout', '600',
  ];

  // Add optional flags
  if (flags) {
    const extraFlags = flags.split(/\s+/).filter(f => f.startsWith('--'));
    args.push(...extraFlags);
  }

  // Load API keys from .env
  const envVars = loadEnvFile();
  const env: Record<string, string> = { ...process.env as Record<string, string> };

  // Pass through research-relevant keys
  const keyNames = [
    'AUTH_TOKEN', 'CT0', 'SCRAPECREATORS_API_KEY',
    'XAI_API_KEY', 'OPENAI_API_KEY', 'PARALLEL_API_KEY',
    'BRAVE_API_KEY', 'OPENROUTER_API_KEY', 'APIFY_API_TOKEN',
  ];
  for (const key of keyNames) {
    if (envVars[key]) env[key] = envVars[key];
  }

  return new Promise((resolve) => {
    logger.info({ topic, flags }, 'Starting last30days research');

    const proc = spawn('python3', args, {
      cwd: skillRoot,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (data) => { stdout += data.toString(); });
    proc.stderr.on('data', (data) => { stderr += data.toString(); });
    proc.stdin.end();

    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      resolve({ success: false, message: `Research timed out (10 min) for topic: ${topic}` });
    }, 600000);

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        logger.error({ code, stderr: stderr.slice(0, 500) }, 'last30days script failed');
        resolve({ success: false, message: `Script exited with code ${code}: ${stderr.slice(0, 1000)}` });
        return;
      }
      resolve({ success: true, message: stdout });
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      resolve({ success: false, message: `Failed to spawn python3: ${err.message}` });
    });
  });
}

// Write result to IPC results directory
function writeResult(dataDir: string, sourceGroup: string, requestId: string, result: SkillResult): void {
  const resultsDir = path.join(dataDir, 'ipc', sourceGroup, 'last30days_results');
  fs.mkdirSync(resultsDir, { recursive: true });
  const resultPath = path.join(resultsDir, `${requestId}.json`);
  fs.writeFileSync(resultPath, JSON.stringify(result));
}

/**
 * Handle last30days research IPC messages
 *
 * @returns true if message was handled, false if not a last30days message
 */
export async function handleLast30DaysIpc(
  data: Record<string, unknown>,
  sourceGroup: string,
  _isMain: boolean,
  dataDir: string
): Promise<boolean> {
  const type = data.type as string;

  // Only handle last30days_* types
  if (!type?.startsWith('last30days_')) {
    return false;
  }

  const requestId = data.requestId as string;
  if (!requestId) {
    logger.warn({ type }, 'last30days request blocked: missing requestId');
    return true;
  }

  logger.info({ type, requestId, sourceGroup }, 'Processing last30days request');

  if (type === 'last30days_research') {
    const topics = data.topics as string;
    const flags = (data.flags as string) || '';

    if (!topics) {
      writeResult(dataDir, sourceGroup, requestId, { success: false, message: 'Missing topics' });
      return true;
    }

    // Split on ||| and research each topic
    const topicList = topics.split('|||').map(t => t.trim()).filter(Boolean);
    const results: string[] = [];

    for (const topic of topicList) {
      const result = await runResearch(topic, flags);
      if (result.success) {
        results.push(result.message);
      } else {
        results.push(`## Error researching "${topic}"\n${result.message}`);
      }
    }

    const combined: SkillResult = {
      success: true,
      message: results.join('\n\n---\n\n'),
    };

    writeResult(dataDir, sourceGroup, requestId, combined);
    logger.info({ requestId, topicCount: topicList.length }, 'last30days research completed');
  } else {
    writeResult(dataDir, sourceGroup, requestId, { success: false, message: `Unknown type: ${type}` });
  }

  return true;
}
