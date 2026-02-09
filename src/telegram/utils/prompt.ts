import { MODELS, type ModelId, type Message } from "../../ai/claude.js";
import { getWorkspacePath } from "../../workspace/index.js";
import { getToolsDescription } from "../../tools/index.js";
import { getWorkspace } from "./cache.js";
import { embed } from "../../memory/embeddings.js";
import { search } from "../../memory/vectorStore.js";
import { buildContextForPrompt, getCurrentChatId } from "../../session/state.js";
import {
  SEARCH_CONTEXT_LENGTH,
  PROMPT_MEMORY_SEARCH_LIMIT,
  PROMPT_MEMORY_MIN_SCORE,
  MEMORY_PREVIEW_LENGTH,
} from "../../utils/constants.js";
import * as os from "os";

// ============== Runtime 정보 ==============

interface RuntimeInfo {
  host: string;
  os: string;
  arch: string;
  nodeVersion: string;
  model: string;
  channel: string;
  capabilities: string[];
}

function getRuntimeInfo(modelId: ModelId): RuntimeInfo {
  const model = MODELS[modelId];
  return {
    host: os.hostname(),
    os: `${os.type()} ${os.release()}`,
    arch: os.arch(),
    nodeVersion: process.version,
    model: model.name,
    channel: "telegram",
    capabilities: ["markdown", "inline_keyboard", "reactions", "voice_messages"],
  };
}

function buildRuntimeLine(runtime: RuntimeInfo): string {
  return `Runtime: host=${runtime.host} | os=${runtime.os} (${runtime.arch}) | node=${runtime.nodeVersion} | model=${runtime.model} | channel=${runtime.channel} | capabilities=${runtime.capabilities.join(",")}`;
}

// ============== 날짜/시간 ==============

interface DateTimeInfo {
  formatted: string;
  timezone: string;
  iso: string;
}

function getKoreanDateTime(): DateTimeInfo {
  const now = new Date();
  const timezone = "Asia/Seoul";

  const formatter = new Intl.DateTimeFormat("ko-KR", {
    timeZone: timezone,
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "long",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });

  return {
    formatted: formatter.format(now),
    timezone: `${timezone} (GMT+9)`,
    iso: now.toISOString(),
  };
}

// ============== 이름 추출 ==============

export function extractName(identityContent: string | null): string | null {
  if (!identityContent) return null;

  const match = identityContent.match(/##\s*이름\s*\n+([^\n(]+)/);
  if (match && match[1]) {
    const name = match[1].trim();
    if (name && !name.includes("정해지지") && !name.includes("아직")) {
      return name;
    }
  }
  return null;
}

// ============== 메모리 검색 ==============

function extractSearchContext(history: Message[]): string {
  const recent = history.slice(-3);
  return recent
    .filter((m) => m.role === "user")
    .map((m) => (typeof m.content === "string" ? m.content : ""))
    .join(" ")
    .slice(0, SEARCH_CONTEXT_LENGTH);
}

async function getRelevantMemories(history: Message[]): Promise<string> {
  try {
    const context = extractSearchContext(history);
    if (!context.trim()) return "";

    const queryEmbedding = await embed(context);
    const results = await search(queryEmbedding, PROMPT_MEMORY_SEARCH_LIMIT, PROMPT_MEMORY_MIN_SCORE);

    if (results.length === 0) return "";

    return results
      .map((r) => `- (${r.source}): ${r.text.slice(0, MEMORY_PREVIEW_LENGTH)}${r.text.length > MEMORY_PREVIEW_LENGTH ? "..." : ""}`)
      .join("\n");
  } catch {
    return "";
  }
}

// ============== 도구 설명 섹션 ==============

const TOOL_SUMMARIES: Record<string, string> = {
  read_file: "Read file contents",
  write_file: "Create or overwrite files",
  edit_file: "Make precise edits to files",
  list_directory: "List directory contents",
  run_command: "Run shell commands (supports background mode)",
  list_sessions: "List background command sessions",
  get_session_log: "Get logs from a background session",
  kill_session: "Terminate a background session",
  web_search: "Search the web (Brave API)",
  web_fetch: "Fetch and extract readable content from a URL",
  set_reminder: "Set a reminder (cron-based)",
  list_reminders: "List active reminders",
  delete_reminder: "Delete a reminder",
  cron_add: "Add a cron job",
  cron_list: "List cron jobs",
  cron_remove: "Remove a cron job",
  cron_toggle: "Enable/disable a cron job",
  cron_run: "Run a cron job immediately",
  calendar_today: "Get today's calendar events",
  calendar_list: "List calendar events in a date range",
  calendar_add: "Add a calendar event",
  calendar_delete: "Delete a calendar event",
  heartbeat_set: "Configure heartbeat polling",
  heartbeat_get: "Get heartbeat configuration",
  heartbeat_disable: "Disable heartbeat",
  heartbeat_run: "Run heartbeat check now",
  briefing_set: "Configure daily briefing",
  briefing_get: "Get briefing configuration",
  briefing_disable: "Disable briefing",
  briefing_send: "Send briefing now",
  save_persona: "Save persona during onboarding",
  save_memory: "Append to memory file",
  spawn_agent: "Spawn a background agent for complex tasks",
  list_agents: "List running background agents",
  cancel_agent: "Cancel a background agent",
  memory_search: "Search memories by semantic similarity",
  memory_reindex: "Reindex all memory files",
};

function buildToolAvailabilitySection(): string {
  const lines = [
    "## Tooling",
    "Tool availability:",
    "",
  ];

  for (const [name, description] of Object.entries(TOOL_SUMMARIES)) {
    lines.push(`- ${name}: ${description}`);
  }

  return lines.join("\n");
}

// ============== 메시지 가이드 섹션 ==============

function buildMessagingSection(): string {
  return `## Messaging
- Reply naturally in the conversation; your response is automatically sent to Telegram.
- Use \`spawn_agent\` for complex, long-running tasks that need background processing.
- Agent results are automatically reported back to the chat.

## Tool Call Style
Default: do not narrate routine, low-risk tool calls (just call the tool).
Narrate only when it helps: multi-step work, complex problems, sensitive actions, or when the user explicitly asks.
Keep narration brief and value-dense; avoid repeating obvious steps.`;
}

// ============== 하트비트/침묵 응답 섹션 ==============

function buildHeartbeatSection(): string {
  return `## Heartbeats
When you receive a heartbeat poll, and there is nothing that needs attention, reply exactly:
HEARTBEAT_OK

If something needs attention, reply with the alert text instead (do NOT include "HEARTBEAT_OK").

Things to check during heartbeats (rotate through these):
- Upcoming reminders or calendar events
- Pending tasks or follow-ups
- Anything noteworthy to proactively mention`;
}

// ============== 메인 빌드 함수 ==============

export async function buildSystemPrompt(modelId: ModelId, history?: Message[]): Promise<string> {
  const workspace = await getWorkspace();
  const runtime = getRuntimeInfo(modelId);
  const dateTime = getKoreanDateTime();
  const parts: string[] = [];

  // ===== 1. Core Identity =====
  parts.push("You are a personal AI companion running on CompanionBot.");
  parts.push("");

  // ===== 2. Tooling Section =====
  parts.push(buildToolAvailabilitySection());
  parts.push("");

  // ===== 3. Messaging & Tool Style =====
  parts.push(buildMessagingSection());
  parts.push("");

  // ===== 4. Workspace =====
  parts.push("## Workspace");
  parts.push(`Your working directory is: ${getWorkspacePath()}`);
  parts.push("Treat this directory as the single global workspace for file operations unless explicitly instructed otherwise.");
  parts.push("");

  // ===== 5. Current Date & Time =====
  parts.push("## Current Date & Time");
  parts.push(`Time zone: ${dateTime.timezone}`);
  parts.push(`Current time: ${dateTime.formatted}`);
  parts.push("");

  // ===== 6. Heartbeat Guide =====
  parts.push(buildHeartbeatSection());
  parts.push("");

  // ===== 7. Runtime =====
  parts.push("## Runtime");
  parts.push(buildRuntimeLine(runtime));
  parts.push("");

  // ===== 8. Project Context (Workspace Files) =====
  parts.push("# Project Context");
  parts.push("");
  parts.push("The following workspace files have been loaded:");
  parts.push("");

  // BOOTSTRAP 모드
  if (workspace.bootstrap) {
    parts.push("## BOOTSTRAP.md (Onboarding Mode)");
    parts.push("");
    parts.push(workspace.bootstrap);
    parts.push("");
    parts.push("---");
    parts.push("Complete onboarding, then use `save_persona` tool to save settings.");
    parts.push("");
  } else {
    // 일반 모드: 워크스페이스 파일들
    if (workspace.identity) {
      parts.push("## IDENTITY.md");
      parts.push("");
      parts.push(workspace.identity);
      parts.push("");
    }

    if (workspace.soul) {
      parts.push("## SOUL.md");
      parts.push("");
      parts.push("If SOUL.md is present, embody its persona and tone. Avoid stiff, generic replies; follow its guidance.");
      parts.push("");
      parts.push(workspace.soul);
      parts.push("");
    }

    if (workspace.user) {
      parts.push("## USER.md");
      parts.push("");
      parts.push(workspace.user);
      parts.push("");
    }

    if (workspace.agents) {
      parts.push("## AGENTS.md");
      parts.push("");
      parts.push(workspace.agents);
      parts.push("");
    }

    // TOOLS.md - 도구 사용 로컬 설정/노트
    if (workspace.tools) {
      parts.push("## TOOLS.md");
      parts.push("");
      parts.push("Local notes for tool usage (camera names, SSH details, voice preferences, etc.)");
      parts.push("");
      parts.push(workspace.tools);
      parts.push("");
    }

    // 핀된 맥락 (히스토리 트리밍과 무관하게 유지됨)
    const chatId = getCurrentChatId();
    if (chatId) {
      const pinnedContext = buildContextForPrompt(chatId);
      if (pinnedContext) {
        parts.push("## 📌 Pinned Context (always remember)");
        parts.push("");
        parts.push(pinnedContext);
        parts.push("");
      }
    }

    // 최근 Daily Memory (오늘/어제 - 벡터 검색 없이 직접 포함)
    if (workspace.recentDaily) {
      parts.push("## Recent Daily Memory (Today/Yesterday)");
      parts.push("");
      parts.push("These are your recent conversation logs. Use them for context continuity.");
      parts.push("");
      parts.push(workspace.recentDaily);
      parts.push("");
    }

    // 관련 기억 (벡터 검색 - 더 오래된 기록에서)
    if (history && history.length > 0) {
      const relevantMemories = await getRelevantMemories(history);
      if (relevantMemories) {
        parts.push("## Relevant Memories (vector search from older records)");
        parts.push("");
        parts.push(relevantMemories);
        parts.push("");
      }
    }

    // 장기 기억
    if (workspace.memory) {
      parts.push("## MEMORY.md (Long-term Memory)");
      parts.push("");
      parts.push("Curated important information. Update this when you learn significant things about the user.");
      parts.push("");
      parts.push(workspace.memory);
      parts.push("");
    }
  }

  // 잘린 파일 경고
  if (workspace.truncated && workspace.truncated.length > 0) {
    parts.push("");
    parts.push(`⚠️ Note: These files were truncated due to size limits: ${workspace.truncated.join(", ")}`);
    parts.push("Use read_file tool to see full contents if needed.");
    parts.push("");
  }

  // ===== 9. Tools Schema (for Claude) =====
  parts.push("---");
  parts.push("");
  parts.push(getToolsDescription(modelId));

  return parts.join("\n");
}
