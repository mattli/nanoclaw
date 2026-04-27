import { ChildProcess, execFile } from 'child_process';
import { CronExpressionParser } from 'cron-parser';
import fs from 'fs';

import { ASSISTANT_NAME, SCHEDULER_POLL_INTERVAL, TIMEZONE } from './config.js';
import {
  ContainerOutput,
  runContainerAgent,
  writeTasksSnapshot,
} from './container-runner.js';
import {
  getAllTasks,
  getDueTasks,
  getTaskById,
  logTaskRun,
  updateTask,
  updateTaskAfterRun,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { logger } from './logger.js';
import { RegisteredGroup, ScheduledTask } from './types.js';

// Anthropic edge outages occasionally exceed the credential proxy's
// 3-min retry deadline, surfacing as `API Error: 5xx` (proxy gave up) or
// raw socket errors (proxy never connected). When that happens we'd
// rather absorb the outage than drop the run on the floor — so the
// scheduler reschedules the same task for +5 min, up to 2 retries
// (3 attempts total spread over ~10 min). In-memory map; resets on
// process restart, which is fine — restart implies the operator is
// already handling whatever broke.
const TRANSIENT_ERROR_PATTERN =
  /API Error: 5\d\d|ECONNRESET|socket hang up|ETIMEDOUT|EAI_AGAIN/i;
const MAX_TRANSIENT_RETRIES = 2;
const TRANSIENT_RETRY_DELAY_MS = 5 * 60 * 1000;
const transientRetryCount = new Map<string, number>();

function isTransientError(error: string | null): boolean {
  return !!error && TRANSIENT_ERROR_PATTERN.test(error);
}

/**
 * Compute the next run time for a recurring task, anchored to the
 * task's scheduled time rather than Date.now() to prevent cumulative
 * drift on interval-based tasks.
 *
 * Co-authored-by: @community-pr-601
 */
export function computeNextRun(task: ScheduledTask): string | null {
  if (task.schedule_type === 'once') return null;

  const now = Date.now();

  if (task.schedule_type === 'cron') {
    const interval = CronExpressionParser.parse(task.schedule_value, {
      tz: TIMEZONE,
    });
    return interval.next().toISOString();
  }

  if (task.schedule_type === 'interval') {
    const ms = parseInt(task.schedule_value, 10);
    if (!ms || ms <= 0) {
      // Guard against malformed interval that would cause an infinite loop
      logger.warn(
        { taskId: task.id, value: task.schedule_value },
        'Invalid interval value',
      );
      return new Date(now + 60_000).toISOString();
    }
    // Anchor to the scheduled time, not now, to prevent drift.
    // Skip past any missed intervals so we always land in the future.
    let next = new Date(task.next_run!).getTime() + ms;
    while (next <= now) {
      next += ms;
    }
    return new Date(next).toISOString();
  }

  return null;
}

export interface SchedulerDependencies {
  registeredGroups: () => Record<string, RegisteredGroup>;
  refreshGroups: () => void;
  getSessions: () => Record<string, string>;
  queue: GroupQueue;
  onProcess: (
    groupJid: string,
    proc: ChildProcess,
    containerName: string,
    groupFolder: string,
  ) => void;
  sendMessage: (jid: string, text: string) => Promise<void>;
}

/**
 * Run a script task directly on the host (no container, no AI tokens).
 * The task's prompt is executed as a bash command.
 */
async function runScriptTask(
  task: ScheduledTask,
  deps: SchedulerDependencies,
): Promise<void> {
  const startTime = Date.now();

  logger.info({ taskId: task.id }, 'Running script task');

  let result: string | null = null;
  let error: string | null = null;

  try {
    const output = await new Promise<string>((resolve, reject) => {
      execFile(
        '/bin/bash',
        ['-c', task.prompt],
        { timeout: 60_000 },
        (err, stdout, stderr) => {
          if (err) reject(new Error(stderr || err.message));
          else resolve(stdout.trim());
        },
      );
    });
    result = output || 'Completed';
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    logger.error({ taskId: task.id, error }, 'Script task failed');
    await deps.sendMessage(task.chat_jid, `${task.id}: ❌ failed`);
  }

  const durationMs = Date.now() - startTime;
  logger.info({ taskId: task.id, durationMs }, 'Script task completed');

  logTaskRun({
    task_id: task.id,
    run_at: new Date().toISOString(),
    duration_ms: durationMs,
    status: error ? 'error' : 'success',
    result,
    error,
  });

  const nextRun = computeNextRun(task);
  const resultSummary = error
    ? `Error: ${error}`
    : result
      ? result.slice(0, 200)
      : 'Completed';
  updateTaskAfterRun(task.id, nextRun, resultSummary);
}

async function runTask(
  task: ScheduledTask,
  deps: SchedulerDependencies,
): Promise<void> {
  if (task.context_mode === 'script') {
    return runScriptTask(task, deps);
  }

  const startTime = Date.now();
  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(task.group_folder);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    // Stop retry churn for malformed legacy rows.
    updateTask(task.id, { status: 'paused' });
    logger.error(
      { taskId: task.id, groupFolder: task.group_folder, error },
      'Task has invalid group folder',
    );
    logTaskRun({
      task_id: task.id,
      run_at: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
      status: 'error',
      result: null,
      error,
    });
    return;
  }
  fs.mkdirSync(groupDir, { recursive: true });

  logger.info(
    { taskId: task.id, group: task.group_folder },
    'Running scheduled task',
  );

  const groups = deps.registeredGroups();
  const group = Object.values(groups).find(
    (g) => g.folder === task.group_folder,
  );

  if (!group) {
    updateTask(task.id, { status: 'paused' });
    logger.error(
      { taskId: task.id, groupFolder: task.group_folder },
      'Group not found for task — paused to prevent retry churn',
    );
    logTaskRun({
      task_id: task.id,
      run_at: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
      status: 'error',
      result: null,
      error: `Group not found: ${task.group_folder}`,
    });
    const label = task.display_name || task.id;
    await deps.sendMessage(
      task.chat_jid,
      `${label}: ⚠️ paused — group "${task.group_folder}" not found`,
    );
    return;
  }

  // Update tasks snapshot for container to read (filtered by group)
  const isMain = group.isMain === true;
  const tasks = getAllTasks();
  writeTasksSnapshot(
    task.group_folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      script: t.script,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  let result: string | null = null;
  let error: string | null = null;

  // For group context mode, use the group's current session
  const sessions = deps.getSessions();
  const sessionId =
    task.context_mode === 'group' ? sessions[task.group_folder] : undefined;

  // After the task produces a result, close the container promptly.
  // Tasks are single-turn — no need to wait IDLE_TIMEOUT (30 min) for the
  // query loop to time out. A short delay handles any final MCP calls.
  const TASK_CLOSE_DELAY_MS = 10000;
  let closeTimer: ReturnType<typeof setTimeout> | null = null;

  const scheduleClose = () => {
    if (closeTimer) return; // already scheduled
    closeTimer = setTimeout(() => {
      logger.debug({ taskId: task.id }, 'Closing task container after result');
      deps.queue.closeStdin(task.chat_jid);
    }, TASK_CLOSE_DELAY_MS);
  };

  try {
    const output = await runContainerAgent(
      group,
      {
        prompt: task.prompt,
        sessionId,
        groupFolder: task.group_folder,
        chatJid: task.chat_jid,
        isMain,
        isScheduledTask: true,
        assistantName: ASSISTANT_NAME,
        script: task.script || undefined,
      },
      (proc, containerName) =>
        deps.onProcess(task.chat_jid, proc, containerName, task.group_folder),
      async (streamedOutput: ContainerOutput) => {
        if (streamedOutput.result) {
          result = streamedOutput.result;
          scheduleClose();
        }
        if (streamedOutput.status === 'success') {
          deps.queue.notifyIdle(task.chat_jid);
          scheduleClose(); // Close promptly even when result is null (e.g. IPC-only tasks)
        }
        if (streamedOutput.status === 'error') {
          error = streamedOutput.error || 'Unknown error';
        }
      },
    );

    if (closeTimer) clearTimeout(closeTimer);

    if (output.status === 'error') {
      error = output.error || 'Unknown error';
    } else if (output.result) {
      result = output.result;
    }

    logger.info(
      { taskId: task.id, durationMs: Date.now() - startTime },
      'Task completed',
    );

    const label = task.display_name || task.id;
    if (error) {
      await deps.sendMessage(task.chat_jid, `${label}: ❌ failed`);
    } else if (!isMain) {
      await deps.sendMessage(task.chat_jid, `${label}: ✅ done`);
    }
  } catch (err) {
    if (closeTimer) clearTimeout(closeTimer);
    error = err instanceof Error ? err.message : String(err);
    logger.error({ taskId: task.id, error }, 'Task failed');
  }

  const durationMs = Date.now() - startTime;

  logTaskRun({
    task_id: task.id,
    run_at: new Date().toISOString(),
    duration_ms: durationMs,
    status: error ? 'error' : 'success',
    result,
    error,
  });

  let nextRun = computeNextRun(task);
  let resultSummary = error
    ? `Error: ${error}`
    : result
      ? result.slice(0, 200)
      : 'Completed';

  if (error && isTransientError(error)) {
    const prior = transientRetryCount.get(task.id) ?? 0;
    if (prior < MAX_TRANSIENT_RETRIES) {
      const retryAt = new Date(
        Date.now() + TRANSIENT_RETRY_DELAY_MS,
      ).toISOString();
      transientRetryCount.set(task.id, prior + 1);
      // For one-off tasks, computeNextRun returns null which would mark
      // the task completed. Override so the scheduler picks it up again.
      nextRun = retryAt;
      resultSummary = `Transient error (retry ${prior + 1}/${MAX_TRANSIENT_RETRIES} at ${retryAt}): ${error}`;
      logger.warn(
        { taskId: task.id, attempt: prior + 1, retryAt, error },
        'Rescheduling task after transient API error',
      );
      // Make sure the row is active so the scheduler picks it back up.
      updateTask(task.id, { status: 'active' });
    } else {
      transientRetryCount.delete(task.id);
      logger.error(
        { taskId: task.id, attempts: prior + 1, error },
        'Task exhausted transient retry budget',
      );
    }
  } else if (!error) {
    transientRetryCount.delete(task.id);
  }

  updateTaskAfterRun(task.id, nextRun, resultSummary);
}

let schedulerRunning = false;

export function startSchedulerLoop(deps: SchedulerDependencies): void {
  if (schedulerRunning) {
    logger.debug('Scheduler loop already running, skipping duplicate start');
    return;
  }
  schedulerRunning = true;
  logger.info('Scheduler loop started');

  const loop = async () => {
    try {
      deps.refreshGroups();
      const dueTasks = getDueTasks();
      if (dueTasks.length > 0) {
        logger.info({ count: dueTasks.length }, 'Found due tasks');
      }

      for (const task of dueTasks) {
        // Re-check task status in case it was paused/cancelled
        const currentTask = getTaskById(task.id);
        if (!currentTask || currentTask.status !== 'active') {
          continue;
        }

        // Skip stale cron tasks that missed their window (>10 min late)
        if (
          currentTask.schedule_type === 'cron' &&
          currentTask.next_run &&
          Date.now() - new Date(currentTask.next_run).getTime() > 600_000
        ) {
          const nextRun = computeNextRun(currentTask);
          updateTask(currentTask.id, { next_run: nextRun });
          logger.info(
            { taskId: currentTask.id, nextRun },
            'Advancing stale cron task',
          );
          continue;
        }

        deps.queue.enqueueTask(currentTask.chat_jid, currentTask.id, () =>
          runTask(currentTask, deps),
        );
      }
    } catch (err) {
      logger.error({ err }, 'Error in scheduler loop');
    }

    setTimeout(loop, SCHEDULER_POLL_INTERVAL);
  };

  loop();
}

/** @internal - for tests only. */
export function _resetSchedulerLoopForTests(): void {
  schedulerRunning = false;
}
