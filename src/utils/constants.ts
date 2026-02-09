/**
 * Application-wide constants
 */

// ============== API & Network ==============
export const MAX_RETRIES = 3;
export const BASE_RETRY_DELAY_MS = 1000;

// ============== Message Limits ==============
/** Telegram message character limit */
export const TELEGRAM_MESSAGE_LIMIT = 4096;
/** Safe limit with buffer for markdown formatting */
export const TELEGRAM_SAFE_LIMIT = 4000;
/** Tool result truncation limit */
export const TOOL_RESULT_MAX_LENGTH = 10000;
/** Web fetch content limit */
export const WEB_FETCH_MAX_CHARS = 5000;

// ============== Session Management ==============
/** Maximum output lines kept in process session buffer */
export const SESSION_MAX_OUTPUT_LINES = 1000;
/** Interval for cleaning up stale sessions */
export const SESSION_CLEANUP_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes
/** Time-to-live for completed sessions */
export const SESSION_TTL_MS = 60 * 60 * 1000; // 1 hour

// ============== Tool Execution ==============
/** Maximum iterations for tool use loop */
export const MAX_TOOL_ITERATIONS = 10;
/** Command execution timeout (seconds) */
export const COMMAND_TIMEOUT_SECONDS = 30;

// ============== Heartbeat ==============
/** Default heartbeat interval in milliseconds */
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

// ============== Lock Configuration ==============
export const LOCK_TIMEOUT_MS = 5000;
export const LOCK_RETRY_MS = 50;
export const LOCK_MAX_RETRIES = 100;

// ============== Calendar ==============
export const CALENDAR_AUTH_PORT = 3847;
export const CALENDAR_AUTH_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
export const DEFAULT_EVENT_DURATION_MS = 60 * 60 * 1000; // 1 hour

// ============== Search ==============
export const DEFAULT_SEARCH_RESULTS = 5;
export const MAX_SEARCH_RESULTS = 20;

// ============== Memory ==============
export const DEFAULT_MEMORY_SEARCH_LIMIT = 5;
export const DEFAULT_MEMORY_MIN_SCORE = 0.3;
/** Memory preview length in search results */
export const MEMORY_PREVIEW_LENGTH = 200;
/** Context extraction length for memory search */
export const SEARCH_CONTEXT_LENGTH = 500;
/** Memory search limit for prompt context (fewer, more relevant) */
export const PROMPT_MEMORY_SEARCH_LIMIT = 3;
/** Minimum score for prompt memory search (stricter) */
export const PROMPT_MEMORY_MIN_SCORE = 0.4;

// ============== Token Estimation ==============
/** Tokens per Korean character (보수적 추정) */
export const TOKENS_PER_KOREAN_CHAR = 1.5;
/** Characters per token for non-Korean text */
export const CHARS_PER_TOKEN_OTHER = 4;
/** Per-message token overhead */
export const MESSAGE_TOKEN_OVERHEAD = 4;

// ============== Tool Usage Logging ==============
/** Max length for tool input summary in history */
export const TOOL_INPUT_SUMMARY_LENGTH = 200;
/** Max length for tool output summary in history */
export const TOOL_OUTPUT_SUMMARY_LENGTH = 500;
