/**
 * Time-related utility functions and constants
 */

// ============== Time Constants (milliseconds) ==============
export const MS_PER_SECOND = 1000;
export const MS_PER_MINUTE = 60 * MS_PER_SECOND;
export const MS_PER_HOUR = 60 * MS_PER_MINUTE;
export const MS_PER_DAY = 24 * MS_PER_HOUR;

// Common intervals
export const INTERVAL_1_MINUTE = MS_PER_MINUTE;
export const INTERVAL_5_MINUTES = 5 * MS_PER_MINUTE;
export const INTERVAL_10_MINUTES = 10 * MS_PER_MINUTE;
export const INTERVAL_30_MINUTES = 30 * MS_PER_MINUTE;
export const INTERVAL_1_HOUR = MS_PER_HOUR;
export const INTERVAL_24_HOURS = MS_PER_DAY;

// ============== Utility Functions ==============

/**
 * Sleep for specified milliseconds
 * @param ms - Milliseconds to wait
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Format milliseconds to human readable string
 * @param ms - Milliseconds
 * @returns Formatted string like "2h 30m" or "45s"
 */
export function formatDuration(ms: number): string {
  if (ms < MS_PER_MINUTE) {
    return `${Math.round(ms / MS_PER_SECOND)}s`;
  }
  if (ms < MS_PER_HOUR) {
    return `${Math.round(ms / MS_PER_MINUTE)}m`;
  }
  const hours = Math.floor(ms / MS_PER_HOUR);
  const minutes = Math.round((ms % MS_PER_HOUR) / MS_PER_MINUTE);
  return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
}

/**
 * Convert minutes to milliseconds
 */
export function minutesToMs(minutes: number): number {
  return minutes * MS_PER_MINUTE;
}

/**
 * Convert hours to milliseconds
 */
export function hoursToMs(hours: number): number {
  return hours * MS_PER_HOUR;
}
