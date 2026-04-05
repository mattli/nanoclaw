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

import { logger } from '../logger.js';

interface SkillResult {
  success: boolean;
  message: string;
}

// Locate the last30days script
function findScriptRoot(): string | null {
  const candidates = [
    path.join(
      os.homedir(),
      '.claude',
      'plugins',
      'marketplaces',
      'last30days-skill',
    ),
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

// Locate the vendored bird-search.mjs wrapper
function findBirdSearch(): string | null {
  const skillRoot = findScriptRoot();
  if (!skillRoot) return null;
  const birdPath = path.join(
    skillRoot,
    'scripts',
    'lib',
    'vendor',
    'bird-search',
    'bird-search.mjs',
  );
  return fs.existsSync(birdPath) ? birdPath : null;
}

// Run a bird-search query and return parsed JSON results
async function runBirdSearch(
  query: string,
  count: number = 20,
): Promise<{ success: boolean; tweets: Array<Record<string, unknown>> }> {
  const birdPath = findBirdSearch();
  if (!birdPath) {
    return { success: false, tweets: [] };
  }

  const envVars = loadEnvFile();
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
  };

  // Inject X credentials
  if (envVars['X_AUTH_TOKEN']) env['AUTH_TOKEN'] = envVars['X_AUTH_TOKEN'];
  if (envVars['X_CT0']) env['CT0'] = envVars['X_CT0'];
  env['BIRD_DISABLE_BROWSER_COOKIES'] = '1';

  // Ensure Node.js is in PATH
  const extraPaths = ['/opt/homebrew/bin', '/opt/homebrew/sbin'];
  const currentPath = env['PATH'] || '/usr/bin:/bin';
  const missing = extraPaths.filter((p) => !currentPath.includes(p));
  if (missing.length) {
    env['PATH'] = [...missing, currentPath].join(':');
  }

  return new Promise((resolve) => {
    const proc = spawn(
      'node',
      [birdPath, '--json', `--count=${count}`, query],
      { env, stdio: ['pipe', 'pipe', 'pipe'] },
    );

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
    });
    proc.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });
    proc.stdin.end();

    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      resolve({ success: false, tweets: [] });
    }, 30000);

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        logger.error(
          { code, stderr: stderr.slice(0, 300) },
          'Bird search failed',
        );
        resolve({ success: false, tweets: [] });
        return;
      }
      try {
        const tweets = JSON.parse(stdout);
        resolve({ success: true, tweets: Array.isArray(tweets) ? tweets : [] });
      } catch {
        resolve({ success: false, tweets: [] });
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      logger.error({ err: err.message }, 'Bird search spawn failed');
      resolve({ success: false, tweets: [] });
    });
  });
}

// Two-phase thread search: find starters, then fetch their replies
async function runThreadSearch(
  query: string,
  maxThreads: number = 10,
): Promise<SkillResult> {
  // Phase 1: Find thread starters
  logger.info({ query }, 'Thread search phase 1: finding starters');
  const starters = await runBirdSearch(query, 50);
  if (!starters.success || starters.tweets.length === 0) {
    return {
      success: false,
      message: 'No thread starters found for query: ' + query,
    };
  }

  // Filter to root tweets (conversationId === id) with replies
  const rootTweets = starters.tweets.filter(
    (t) => t.conversationId === t.id && ((t.replyCount as number) || 0) > 0,
  );

  // Sort by reply count descending, take top N
  rootTweets.sort(
    (a, b) => ((b.replyCount as number) || 0) - ((a.replyCount as number) || 0),
  );
  const topThreads = rootTweets.slice(0, maxThreads);

  if (topThreads.length === 0) {
    return {
      success: true,
      message: JSON.stringify({
        threads: [],
        meta: {
          query,
          totalStarters: starters.tweets.length,
          rootTweetsWithReplies: 0,
        },
      }),
    };
  }

  // Phase 2: Fetch replies for each thread
  logger.info(
    { count: topThreads.length },
    'Thread search phase 2: fetching replies',
  );
  const threads: Array<Record<string, unknown>> = [];

  for (const starter of topThreads) {
    const threadId = starter.id as string;
    const replies = await runBirdSearch(`conversation_id:${threadId}`, 100);
    threads.push({
      starter,
      replies: replies.success ? replies.tweets : [],
      replyCount: (starter.replyCount as number) || 0,
      fetchedReplies: replies.success ? replies.tweets.length : 0,
    });
  }

  const result = {
    threads,
    meta: {
      query,
      totalStarters: starters.tweets.length,
      rootTweetsWithReplies: rootTweets.length,
      threadsFetched: threads.length,
    },
  };

  logger.info(
    {
      threadsFetched: threads.length,
      totalReplies: threads.reduce(
        (sum, t) => sum + (t.fetchedReplies as number),
        0,
      ),
    },
    'Thread search completed',
  );

  return { success: true, message: JSON.stringify(result) };
}

// Run the last30days Python script for a single topic
async function runResearch(topic: string, flags: string): Promise<SkillResult> {
  const skillRoot = findScriptRoot();
  if (!skillRoot) {
    return {
      success: false,
      message: 'Could not find last30days scripts. Is the plugin installed?',
    };
  }

  const scriptPath = path.join(skillRoot, 'scripts', 'last30days.py');
  const saveDir = path.join(os.homedir(), 'Documents', 'Last30Days');
  fs.mkdirSync(saveDir, { recursive: true });

  // Build args
  // Parse optional flags first to allow overrides
  const parsedFlags: Record<string, string | null> = {};
  if (flags) {
    const parts = flags.split(/\s+/);
    for (let i = 0; i < parts.length; i++) {
      if (parts[i].startsWith('--')) {
        if (parts[i].includes('=')) {
          const [key, val] = parts[i].split('=', 2);
          parsedFlags[key] = val;
        } else if (i + 1 < parts.length && !parts[i + 1].startsWith('--')) {
          parsedFlags[parts[i]] = parts[i + 1];
          i++;
        } else {
          parsedFlags[parts[i]] = null; // boolean flag like --quick
        }
      }
    }
  }

  const searchValue = parsedFlags['--search'] || 'reddit,x';
  const timeoutValue = parsedFlags['--timeout'] || '600';

  const args = [
    scriptPath,
    topic,
    '--emit=compact',
    '--no-native-web',
    `--save-dir=${saveDir}`,
    `--search=${searchValue}`,
    `--timeout=${timeoutValue}`,
  ];

  // Add remaining boolean flags (--quick, --deep, etc.)
  for (const [key, val] of Object.entries(parsedFlags)) {
    if (key === '--search' || key === '--timeout') continue;
    if (val === null) args.push(key);
    else args.push(`${key}=${val}`);
  }

  // Load API keys from .env
  const envVars = loadEnvFile();
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
  };

  // Pass through research-relevant keys
  const keyNames = [
    'SCRAPECREATORS_API_KEY',
    'XAI_API_KEY',
    'OPENAI_API_KEY',
    'PARALLEL_API_KEY',
    'BRAVE_API_KEY',
    'OPENROUTER_API_KEY',
    'APIFY_API_TOKEN',
  ];
  for (const key of keyNames) {
    if (envVars[key]) env[key] = envVars[key];
  }

  // Remap explicit .env names to what the Python scripts expect
  if (envVars['X_AUTH_TOKEN']) env['AUTH_TOKEN'] = envVars['X_AUTH_TOKEN'];
  if (envVars['X_CT0']) env['CT0'] = envVars['X_CT0'];

  // Ensure Homebrew paths are in PATH (launchd has minimal PATH)
  const extraPaths = ['/opt/homebrew/bin', '/opt/homebrew/sbin'];
  const currentPath = env['PATH'] || '/usr/bin:/bin';
  const missing = extraPaths.filter((p) => !currentPath.includes(p));
  if (missing.length) {
    env['PATH'] = [...missing, currentPath].join(':');
  }

  return new Promise((resolve) => {
    logger.info({ topic, flags, searchValue }, 'Starting last30days research');

    const proc = spawn('python3', args, {
      cwd: skillRoot,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
    });
    proc.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });
    proc.stdin.end();

    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      resolve({
        success: false,
        message: `Research timed out (10 min) for topic: ${topic}`,
      });
    }, 600000);

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        logger.error(
          { code, stderr: stderr.slice(0, 500) },
          'last30days script failed',
        );
        resolve({
          success: false,
          message: `Script exited with code ${code}: ${stderr.slice(0, 1000)}`,
        });
        return;
      }
      resolve({ success: true, message: stdout });
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        success: false,
        message: `Failed to spawn python3: ${err.message}`,
      });
    });
  });
}

// Write result to IPC results directory
function writeResult(
  dataDir: string,
  sourceGroup: string,
  requestId: string,
  result: SkillResult,
): void {
  const resultsDir = path.join(
    dataDir,
    'ipc',
    sourceGroup,
    'last30days_results',
  );
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
  dataDir: string,
): Promise<boolean> {
  const type = data.type as string;

  if (!type?.startsWith('last30days_')) {
    return false;
  }

  const requestId = data.requestId as string;
  if (!requestId) {
    logger.warn({ type }, 'last30days request blocked: missing requestId');
    return true;
  }

  logger.info(
    { type, requestId, sourceGroup },
    'Processing last30days request',
  );

  if (type === 'last30days_thread_search') {
    const query = data.query as string;
    const maxThreads = (data.maxThreads as number) || 10;

    if (!query) {
      writeResult(dataDir, sourceGroup, requestId, {
        success: false,
        message: 'Missing query',
      });
      return true;
    }

    const result = await runThreadSearch(query, maxThreads);
    writeResult(dataDir, sourceGroup, requestId, result);
    logger.info(
      { requestId, query: query.slice(0, 80) },
      'last30days thread search completed',
    );
  } else if (type === 'last30days_research') {
    const topics = data.topics as string;
    const flags = (data.flags as string) || '';

    if (!topics) {
      writeResult(dataDir, sourceGroup, requestId, {
        success: false,
        message: 'Missing topics',
      });
      return true;
    }

    // Split on ||| and research each topic
    const topicList = topics
      .split('|||')
      .map((t) => t.trim())
      .filter(Boolean);
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
    logger.info(
      { requestId, topicCount: topicList.length },
      'last30days research completed',
    );
  } else {
    writeResult(dataDir, sourceGroup, requestId, {
      success: false,
      message: `Unknown type: ${type}`,
    });
  }

  return true;
}
