/**
 * Cron Job Store
 *
 * Persists and manages cron jobs with race condition protection.
 */

import * as fs from "fs/promises";
import * as path from "path";
import { getWorkspacePath } from "../workspace/paths.js";
import type { CronJob, CronStore, NewCronJob, Schedule } from "./types.js";

const CRON_FILE = "cron-jobs.json";
const LOCK_FILE = "cron-jobs.lock";
const STORE_VERSION = 1;

// Lock configuration
const LOCK_TIMEOUT_MS = 5000;
const LOCK_RETRY_MS = 50;
const LOCK_MAX_RETRIES = 100;

function getCronFilePath(): string {
  return path.join(getWorkspacePath(), CRON_FILE);
}

function getLockFilePath(): string {
  return path.join(getWorkspacePath(), LOCK_FILE);
}

/**
 * Generate a unique ID without uuid dependency
 */
function generateId(): string {
  return crypto.randomUUID();
}

/**
 * Simple file-based lock for race condition prevention
 */
async function acquireLock(): Promise<boolean> {
  const lockPath = getLockFilePath();
  const lockId = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  for (let i = 0; i < LOCK_MAX_RETRIES; i++) {
    try {
      // Try to create lock file exclusively
      await fs.writeFile(lockPath, lockId, { flag: "wx" });
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        // Lock exists, check if it's stale
        try {
          const stat = await fs.stat(lockPath);
          const age = Date.now() - stat.mtimeMs;
          if (age > LOCK_TIMEOUT_MS) {
            // Stale lock, remove it
            await fs.unlink(lockPath).catch(() => {});
            continue;
          }
        } catch {
          // Lock file gone, retry immediately
          continue;
        }
        // Wait and retry
        await sleep(LOCK_RETRY_MS);
      } else {
        // Other error, assume we can proceed
        return true;
      }
    }
  }

  console.warn("[Cron] Failed to acquire lock after max retries, proceeding anyway");
  return false;
}

async function releaseLock(): Promise<void> {
  try {
    await fs.unlink(getLockFilePath());
  } catch {
    // Ignore errors on unlock
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Execute a function with file lock protection
 */
async function withLock<T>(fn: () => Promise<T>): Promise<T> {
  await acquireLock();
  try {
    return await fn();
  } finally {
    await releaseLock();
  }
}

/**
 * Load all cron jobs from storage (internal, no lock)
 */
async function loadJobsInternal(): Promise<CronJob[]> {
  try {
    const data = await fs.readFile(getCronFilePath(), "utf-8");
    const store: CronStore = JSON.parse(data);
    return store.jobs || [];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    console.error("[Cron] Failed to load jobs:", error);
    return [];
  }
}

/**
 * Save all cron jobs to storage (internal, no lock)
 * Uses atomic write pattern: write to temp file, then rename
 */
async function saveJobsInternal(jobs: CronJob[]): Promise<void> {
  const store: CronStore = {
    version: STORE_VERSION,
    jobs,
  };

  const filePath = getCronFilePath();
  const tempPath = `${filePath}.tmp.${process.pid}`;

  try {
    await fs.writeFile(tempPath, JSON.stringify(store, null, 2), "utf-8");
    await fs.rename(tempPath, filePath);
  } catch (error) {
    // Clean up temp file on error
    await fs.unlink(tempPath).catch(() => {});
    throw error;
  }
}

/**
 * Load all cron jobs from storage
 */
export async function loadJobs(): Promise<CronJob[]> {
  return withLock(() => loadJobsInternal());
}

/**
 * Save all cron jobs to storage
 */
export async function saveJobs(jobs: CronJob[]): Promise<void> {
  return withLock(() => saveJobsInternal(jobs));
}

/**
 * Add a new cron job
 */
export async function addJob(newJob: NewCronJob): Promise<CronJob> {
  return withLock(async () => {
    const jobs = await loadJobsInternal();

    const job: CronJob = {
      ...newJob,
      id: generateId(),
      createdAt: new Date().toISOString(),
      runCount: newJob.runCount ?? 0,
    };

    // Calculate initial nextRun
    if (job.schedule) {
      job.nextRun = calculateNextRun(job.schedule);
    } else {
      // Use cronExpr to calculate next run
      job.nextRun = calculateCronNextRun(job.cronExpr, job.timezone);
    }

    jobs.push(job);
    await saveJobsInternal(jobs);

    return job;
  });
}

/**
 * Remove a cron job by ID
 */
export async function removeJob(jobId: string): Promise<boolean> {
  return withLock(async () => {
    const jobs = await loadJobsInternal();
    const index = jobs.findIndex((j) => j.id === jobId);

    if (index === -1) {
      return false;
    }

    jobs.splice(index, 1);
    await saveJobsInternal(jobs);
    return true;
  });
}

/**
 * Update a cron job (atomic)
 */
export async function updateJob(
  jobId: string,
  updates: Partial<CronJob>
): Promise<CronJob | null> {
  return withLock(async () => {
    const jobs = await loadJobsInternal();
    const index = jobs.findIndex((j) => j.id === jobId);

    if (index === -1) {
      return null;
    }

    jobs[index] = { ...jobs[index], ...updates };
    await saveJobsInternal(jobs);
    return jobs[index];
  });
}

/**
 * Get jobs that are due to run
 */
export async function getDueJobs(): Promise<CronJob[]> {
  const jobs = await loadJobs();
  const now = new Date();

  return jobs.filter((job) => {
    if (!job.enabled) return false;
    if (!job.nextRun) return false;

    // Check if we've exceeded max runs
    if (job.maxRuns !== undefined && (job.runCount || 0) >= job.maxRuns) {
      return false;
    }

    return new Date(job.nextRun) <= now;
  });
}

/**
 * Mark a job as executed and update nextRun (atomic)
 */
export async function markJobExecuted(jobId: string): Promise<void> {
  await withLock(async () => {
    const jobs = await loadJobsInternal();
    const job = jobs.find((j) => j.id === jobId);

    if (!job) return;

    job.lastRun = new Date().toISOString();
    job.runCount = (job.runCount || 0) + 1;

    // Check if job should be disabled (one-time jobs)
    if (job.maxRuns !== undefined && job.runCount >= job.maxRuns) {
      job.enabled = false;
      job.nextRun = undefined;
    } else {
      // Calculate next run
      if (job.schedule) {
        job.nextRun = calculateNextRun(job.schedule);
      } else {
        job.nextRun = calculateCronNextRun(job.cronExpr, job.timezone);
      }
    }

    await saveJobsInternal(jobs);
  });
}

/**
 * Calculate the next run time for a schedule
 */
export function calculateNextRun(schedule: Schedule): string | undefined {
  const now = new Date();

  switch (schedule.kind) {
    case "at": {
      const targetTime = new Date(schedule.atMs);
      // If in the past, no next run
      return targetTime > now ? targetTime.toISOString() : undefined;
    }

    case "every": {
      const intervalMs = schedule.everyMs || schedule.intervalMs || 60000;
      const startAt = schedule.startMs ? new Date(schedule.startMs) : now;
      if (startAt > now) {
        return startAt.toISOString();
      }
      // Next interval from now
      const nextRun = new Date(now.getTime() + intervalMs);
      return nextRun.toISOString();
    }

    case "cron": {
      return calculateCronNextRun(schedule.expression, schedule.timezone);
    }
  }
}

/**
 * Get current time components in a specific timezone
 */
function getTimeInTimezone(date: Date, timezone: string): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  dayOfWeek: number;
} {
  try {
    // Use Intl.DateTimeFormat to get time in target timezone
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      weekday: "short",
      hour12: false,
    });

    const parts = formatter.formatToParts(date);
    const getValue = (type: string): string =>
      parts.find((p) => p.type === type)?.value ?? "0";

    const dayOfWeekMap: Record<string, number> = {
      Sun: 0,
      Mon: 1,
      Tue: 2,
      Wed: 3,
      Thu: 4,
      Fri: 5,
      Sat: 6,
    };

    return {
      year: parseInt(getValue("year"), 10),
      month: parseInt(getValue("month"), 10),
      day: parseInt(getValue("day"), 10),
      hour: parseInt(getValue("hour"), 10),
      minute: parseInt(getValue("minute"), 10),
      dayOfWeek: dayOfWeekMap[getValue("weekday")] ?? 0,
    };
  } catch {
    // Fallback to local time if timezone is invalid
    return {
      year: date.getFullYear(),
      month: date.getMonth() + 1,
      day: date.getDate(),
      hour: date.getHours(),
      minute: date.getMinutes(),
      dayOfWeek: date.getDay(),
    };
  }
}

/**
 * Create a Date object for a specific time in a timezone
 */
function createDateInTimezone(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timezone: string
): Date {
  try {
    // Create a date string and parse it in the target timezone
    const dateStr = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00`;

    // Get the offset for this date/time in the target timezone
    const testDate = new Date(dateStr + "Z");
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });

    // Binary search for the correct UTC time that gives us the target local time
    // Start with a guess assuming no offset
    let guess = new Date(dateStr);

    for (let i = 0; i < 3; i++) {
      const parts = formatter.formatToParts(guess);
      const getValue = (type: string): number =>
        parseInt(parts.find((p) => p.type === type)?.value ?? "0", 10);

      const guessHour = getValue("hour");
      const guessMinute = getValue("minute");
      const guessDay = getValue("day");

      // Calculate difference in minutes
      let diffMinutes = (hour - guessHour) * 60 + (minute - guessMinute);

      // Handle day wrap
      if (day !== guessDay) {
        if (day > guessDay || (day === 1 && guessDay > 20)) {
          diffMinutes += 24 * 60;
        } else {
          diffMinutes -= 24 * 60;
        }
      }

      if (diffMinutes === 0) break;

      guess = new Date(guess.getTime() + diffMinutes * 60 * 1000);
    }

    return guess;
  } catch {
    // Fallback: create local date
    return new Date(year, month - 1, day, hour, minute, 0, 0);
  }
}

/**
 * Parse and calculate next run for cron expression with timezone support
 * Supports: minute hour day month weekday
 */
function calculateCronNextRun(
  expression: string,
  timezone?: string
): string | undefined {
  const parts = expression.split(" ");
  if (parts.length !== 5) {
    console.error("[Cron] Invalid cron expression:", expression);
    return undefined;
  }

  const [minuteExpr, hourExpr, dayOfMonthExpr, monthExpr, dayOfWeekExpr] = parts;
  const now = new Date();
  const tz = timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;

  // Get current time in target timezone
  const current = getTimeInTimezone(now, tz);

  // Parse cron fields
  const targetMinutes = parseCronField(minuteExpr, 0, 59);
  const targetHours = parseCronField(hourExpr, 0, 23);
  const targetDaysOfMonth = parseCronField(dayOfMonthExpr, 1, 31);
  const targetMonths = parseCronField(monthExpr, 1, 12);
  const targetDaysOfWeek = parseCronField(dayOfWeekExpr, 0, 6);

  // Search for next valid time (up to 366 days ahead)
  let searchDate = { ...current };
  const maxIterations = 366 * 24 * 60; // Max 1 year of minutes

  for (let i = 0; i < maxIterations; i++) {
    // Advance by one minute each iteration
    if (i > 0) {
      searchDate.minute++;
      if (searchDate.minute > 59) {
        searchDate.minute = 0;
        searchDate.hour++;
        if (searchDate.hour > 23) {
          searchDate.hour = 0;
          searchDate.day++;
          searchDate.dayOfWeek = (searchDate.dayOfWeek + 1) % 7;

          // Handle month overflow (simplified - assumes 31 days)
          const daysInMonth = getDaysInMonth(searchDate.year, searchDate.month);
          if (searchDate.day > daysInMonth) {
            searchDate.day = 1;
            searchDate.month++;
            if (searchDate.month > 12) {
              searchDate.month = 1;
              searchDate.year++;
            }
          }
        }
      }
    }

    // Check if this time matches all constraints
    if (!targetMonths.includes(searchDate.month)) continue;
    if (!targetDaysOfMonth.includes(searchDate.day)) continue;
    if (!targetDaysOfWeek.includes(searchDate.dayOfWeek)) continue;
    if (!targetHours.includes(searchDate.hour)) continue;
    if (!targetMinutes.includes(searchDate.minute)) continue;

    // Skip if this is the current minute or in the past
    if (i === 0) {
      // First iteration - must be in the future
      continue;
    }

    // Found a match - create the date in the target timezone
    const nextRun = createDateInTimezone(
      searchDate.year,
      searchDate.month,
      searchDate.day,
      searchDate.hour,
      searchDate.minute,
      tz
    );

    // Verify it's in the future
    if (nextRun > now) {
      return nextRun.toISOString();
    }
  }

  console.warn("[Cron] Could not find next run time for:", expression);
  return undefined;
}

/**
 * Get number of days in a month
 */
function getDaysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

/**
 * Parse cron field like "1,3,5" or "1-5" or step values into array of numbers
 */
function parseCronField(field: string, min: number, max: number): number[] {
  if (field === "*") {
    return Array.from({ length: max - min + 1 }, (_, i) => i + min);
  }

  // Handle step values like */5
  if (field.startsWith("*/")) {
    const step = parseInt(field.slice(2), 10);
    const values: number[] = [];
    for (let i = min; i <= max; i += step) {
      values.push(i);
    }
    return values;
  }

  const values: number[] = [];
  const parts = field.split(",");

  for (const part of parts) {
    if (part.includes("-")) {
      const [start, end] = part.split("-").map(Number);
      for (let i = start; i <= end; i++) {
        values.push(i);
      }
    } else if (part.includes("/")) {
      // Handle range with step like 0-30/5
      const [range, stepStr] = part.split("/");
      const step = parseInt(stepStr, 10);
      let rangeStart = min;
      let rangeEnd = max;
      if (range.includes("-")) {
        [rangeStart, rangeEnd] = range.split("-").map(Number);
      }
      for (let i = rangeStart; i <= rangeEnd; i += step) {
        values.push(i);
      }
    } else {
      values.push(parseInt(part, 10));
    }
  }

  return values.filter((v) => v >= min && v <= max);
}

/**
 * Get all jobs for a specific chat
 */
export async function getJobsByChat(chatId: number | string): Promise<CronJob[]> {
  const jobs = await loadJobs();
  const numericChatId = typeof chatId === "string" ? parseInt(chatId, 10) : chatId;
  return jobs.filter((j) => j.chatId === numericChatId);
}

/**
 * Get a job by ID
 */
export async function getJob(jobId: string): Promise<CronJob | undefined> {
  const jobs = await loadJobs();
  return jobs.find((j) => j.id === jobId);
}
