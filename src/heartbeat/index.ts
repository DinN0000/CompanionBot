import * as fs from "fs/promises";
import * as path from "path";
import { getWorkspacePath } from "../workspace/index.js";
import { chat, type ModelId } from "../ai/claude.js";
import { isCalendarConfigured, getTodayEvents, formatEvent } from "../calendar/index.js";
import { getSecret } from "../config/secrets.js";
import { checkForUpdates } from "../updates/index.js";
import { INTERVAL_30_MINUTES, INTERVAL_24_HOURS, hoursToMs } from "../utils/time.js";

type HeartbeatConfig = {
  chatId: number;
  enabled: boolean;
  intervalMs: number; // 밀리초 단위
  lastCheckAt: number; // 마지막 체크 시간
  lastMessageAt: number; // 마지막 대화 시간
};

type HeartbeatStore = {
  configs: HeartbeatConfig[];
};

// 활성 타이머
const activeTimers: Map<number, NodeJS.Timeout> = new Map();

// 메모리 캐시: 타임스탬프는 메모리에만 유지하여 파일 쓰기 최소화
// lastCheckAt, lastMessageAt은 디버깅 용도라 매번 저장할 필요 없음
const timestampCache: Map<number, { lastCheckAt: number; lastMessageAt: number }> = new Map();

// 업데이트 체크 캐시 (하루에 한 번만)
let lastUpdateCheck = 0;
let cachedUpdateInfo: { hasUpdate: boolean; current: string; latest: string } | null = null;
const UPDATE_CHECK_INTERVAL = INTERVAL_24_HOURS;

// 봇 인스턴스
let botInstance: { api: { sendMessage: (chatId: number, text: string) => Promise<unknown> } } | null = null;

// 기본 간격: 30분
const DEFAULT_INTERVAL_MS = INTERVAL_30_MINUTES;

export function setHeartbeatBot(bot: { api: { sendMessage: (chatId: number, text: string) => Promise<unknown> } }): void {
  botInstance = bot;
}

function getConfigPath(): string {
  return path.join(getWorkspacePath(), "heartbeat.json");
}

async function loadStore(): Promise<HeartbeatStore> {
  try {
    const data = await fs.readFile(getConfigPath(), "utf-8");
    return JSON.parse(data);
  } catch {
    return { configs: [] };
  }
}

async function saveStore(store: HeartbeatStore): Promise<void> {
  await fs.writeFile(getConfigPath(), JSON.stringify(store, null, 2));
}

// HEARTBEAT.md 로드
async function loadHeartbeatChecklist(): Promise<string | null> {
  try {
    const filePath = path.join(getWorkspacePath(), "HEARTBEAT.md");
    return await fs.readFile(filePath, "utf-8");
  } catch {
    return null;
  }
}

// 컨텍스트 수집 (날씨, 일정 등)
async function gatherContext(): Promise<string> {
  const parts: string[] = [];
  const now = new Date();

  parts.push(`현재 시간: ${now.toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })}`);

  // 캘린더 일정
  if (await isCalendarConfigured()) {
    try {
      const events = await getTodayEvents();
      if (events.length > 0) {
        const upcoming = events.filter(e => {
          const start = e.start?.dateTime || e.start?.date;
          return start && new Date(start) > now;
        });
        if (upcoming.length > 0) {
          parts.push(`오늘 남은 일정: ${upcoming.map(formatEvent).join(", ")}`);
        }
      }
    } catch {
      // 무시
    }
  }

  // 날씨 (간단히)
  const weatherKey = await getSecret("openweathermap-api-key");
  if (weatherKey) {
    try {
      const url = `https://api.openweathermap.org/data/2.5/weather?q=Seoul&appid=${weatherKey}&units=metric&lang=kr`;
      const response = await fetch(url);
      const data = await response.json();
      if (data.cod === 200) {
        parts.push(`현재 날씨: ${data.weather[0].description}, ${Math.round(data.main.temp)}°C`);
      }
    } catch {
      // 무시
    }
  }

  // 업데이트 체크 (하루에 한 번)
  const timeSinceLastCheck = Date.now() - lastUpdateCheck;
  if (timeSinceLastCheck > UPDATE_CHECK_INTERVAL) {
    try {
      cachedUpdateInfo = await checkForUpdates();
      lastUpdateCheck = Date.now();
      console.log(`[Heartbeat] Update check: current=${cachedUpdateInfo.current}, latest=${cachedUpdateInfo.latest}`);
    } catch (error) {
      console.error("[Heartbeat] Update check failed:", error);
    }
  }

  if (cachedUpdateInfo?.hasUpdate) {
    parts.push(`🆕 업데이트 알림: CompanionBot ${cachedUpdateInfo.latest} 버전이 출시됨! (현재: ${cachedUpdateInfo.current})`);
  }

  return parts.join("\n");
}

// Heartbeat 실행 - 메시지를 보냈으면 true 반환
async function executeHeartbeat(config: HeartbeatConfig): Promise<boolean> {
  if (!botInstance) {
    console.error("[Heartbeat] Bot instance not set");
    return false;
  }

  const checklist = await loadHeartbeatChecklist();
  if (!checklist) {
    console.log("[Heartbeat] No HEARTBEAT.md found");
    return false;
  }

  const context = await gatherContext();

  // 캐시된 타임스탬프 사용 (없으면 config 값 사용)
  const cached = timestampCache.get(config.chatId);
  const lastMessageAt = cached?.lastMessageAt ?? config.lastMessageAt;
  const timeSinceLastMessage = Date.now() - lastMessageAt;
  const hoursSinceLastMessage = Math.floor(timeSinceLastMessage / (1000 * 60 * 60));

  const systemPrompt = `당신은 사용자의 AI 친구입니다.
주기적으로 사용자에게 필요한 알림을 보내는 역할을 합니다.

아래 체크리스트와 현재 상황을 보고, 사용자에게 알릴 게 있는지 판단하세요.

## 체크리스트
${checklist}

## 현재 상황
${context}
마지막 대화: ${hoursSinceLastMessage}시간 전

## 규칙
1. 알릴 게 있으면 친근하게 메시지를 작성하세요.
2. 알릴 게 없으면 정확히 "HEARTBEAT_OK"만 응답하세요.
3. 너무 사소한 것은 알리지 마세요.
4. 메시지는 짧고 자연스럽게 작성하세요.`;

  const messages = [
    { role: "user" as const, content: "Heartbeat 체크를 해주세요." }
  ];

  let messageSent = false;

  try {
    const result = await chat(messages, systemPrompt, "haiku");

    if (!result.text.trim().includes("HEARTBEAT_OK")) {
      await botInstance.api.sendMessage(config.chatId, result.text);
      console.log(`[Heartbeat] Sent message to ${config.chatId}`);
      messageSent = true;

      // 타임스탬프는 메모리 캐시에만 저장 (파일 쓰기 안 함)
      updateTimestampCache(config.chatId, { lastMessageAt: Date.now() });
    } else {
      console.log(`[Heartbeat] OK for ${config.chatId}`);
    }

    // 타임스탬프는 메모리 캐시에만 저장 (파일 쓰기 안 함)
    updateTimestampCache(config.chatId, { lastCheckAt: Date.now() });
  } catch (error) {
    console.error("[Heartbeat] Error:", error);
  }

  return messageSent;
}

// 타임스탬프 캐시 업데이트 헬퍼
function updateTimestampCache(
  chatId: number,
  updates: { lastCheckAt?: number; lastMessageAt?: number }
): void {
  const current = timestampCache.get(chatId) || { lastCheckAt: Date.now(), lastMessageAt: Date.now() };
  timestampCache.set(chatId, { ...current, ...updates });
}

// 실행 중인 heartbeat 추적 (중첩 실행 방지)
const runningHeartbeats: Set<number> = new Set();

// 타이머 스케줄
function scheduleHeartbeat(config: HeartbeatConfig): void {
  // 기존 타이머 취소
  const existing = activeTimers.get(config.chatId);
  if (existing) {
    clearInterval(existing);
    activeTimers.delete(config.chatId);
  }

  if (!config.enabled) return;

  const timer = setInterval(async () => {
    // 이미 실행 중이면 스킵 (중첩 방지)
    if (runningHeartbeats.has(config.chatId)) {
      console.log(`[Heartbeat] Skipping ${config.chatId} - already running`);
      return;
    }
    runningHeartbeats.add(config.chatId);
    try {
      await executeHeartbeat(config);
    } finally {
      runningHeartbeats.delete(config.chatId);
    }
  }, config.intervalMs);

  activeTimers.set(config.chatId, timer);
  console.log(`[Heartbeat] Scheduled for ${config.chatId} every ${config.intervalMs / 60000}min`);
}

// 설정
export async function setHeartbeatConfig(
  chatId: number,
  enabled: boolean,
  intervalMinutes: number = 30
): Promise<HeartbeatConfig> {
  const store = await loadStore();

  const existingIndex = store.configs.findIndex(c => c.chatId === chatId);
  const now = Date.now();

  const config: HeartbeatConfig = {
    chatId,
    enabled,
    intervalMs: intervalMinutes * 60 * 1000,
    lastCheckAt: existingIndex >= 0 ? store.configs[existingIndex].lastCheckAt : now,
    lastMessageAt: existingIndex >= 0 ? store.configs[existingIndex].lastMessageAt : now,
  };

  if (existingIndex >= 0) {
    store.configs[existingIndex] = config;
  } else {
    store.configs.push(config);
  }

  await saveStore(store);

  // 타임스탬프 캐시 초기화
  timestampCache.set(chatId, {
    lastCheckAt: config.lastCheckAt,
    lastMessageAt: config.lastMessageAt,
  });

  scheduleHeartbeat(config);

  return config;
}

// 설정 가져오기 (캐시된 타임스탬프 포함)
export async function getHeartbeatConfig(chatId: number): Promise<HeartbeatConfig | null> {
  const store = await loadStore();
  const config = store.configs.find(c => c.chatId === chatId);
  if (!config) return null;

  // 캐시된 타임스탬프가 있으면 반영
  const cached = timestampCache.get(chatId);
  if (cached) {
    return { ...config, ...cached };
  }
  return config;
}

// 비활성화
export async function disableHeartbeat(chatId: number): Promise<void> {
  const store = await loadStore();
  const config = store.configs.find(c => c.chatId === chatId);

  if (config) {
    config.enabled = false;
    await saveStore(store);

    const timer = activeTimers.get(chatId);
    if (timer) {
      clearInterval(timer);
      activeTimers.delete(chatId);
    }
  }
}

// 대화 시간 업데이트 (메시지 받을 때마다 호출)
// 타임스탬프는 디버깅 용도이므로 메모리에만 저장하여 파일 쓰기 최소화
export function updateLastMessageTime(chatId: number): void {
  updateTimestampCache(chatId, { lastMessageAt: Date.now() });
}

// 모든 Heartbeat 복원 (봇 시작 시)
export async function restoreHeartbeats(): Promise<void> {
  const store = await loadStore();

  for (const config of store.configs) {
    // 파일에 저장된 타임스탬프로 캐시 초기화
    timestampCache.set(config.chatId, {
      lastCheckAt: config.lastCheckAt,
      lastMessageAt: config.lastMessageAt,
    });

    if (config.enabled) {
      scheduleHeartbeat(config);
    }
  }

  console.log(`[Heartbeat] Restored ${activeTimers.size} heartbeats`);
}

// 즉시 실행 (테스트용) - 메시지를 보냈으면 true 반환
export async function runHeartbeatNow(chatId: number): Promise<boolean> {
  const config = await getHeartbeatConfig(chatId);

  if (!config) {
    // 기본 설정으로 실행
    const defaultConfig: HeartbeatConfig = {
      chatId,
      enabled: false,
      intervalMs: DEFAULT_INTERVAL_MS,
      lastCheckAt: Date.now(),
      lastMessageAt: Date.now() - hoursToMs(8), // 8시간 전으로 설정
    };
    return await executeHeartbeat(defaultConfig);
  }

  return await executeHeartbeat(config);
}

// 모든 타이머 정리 (graceful shutdown)
export function cleanupHeartbeats(): void {
  for (const [chatId, timer] of activeTimers) {
    clearInterval(timer);
  }
  activeTimers.clear();
  console.log("[Heartbeat] Cleanup complete");
}
