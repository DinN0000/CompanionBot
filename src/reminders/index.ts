import * as fs from "fs/promises";
import * as path from "path";
import cron from "node-cron";
import { getWorkspacePath } from "../workspace/index.js";

export type Reminder = {
  id: string;
  chatId: number;
  message: string;
  scheduledAt: string; // ISO string
  createdAt: string;
  cronExpr?: string; // for recurring
  recurring: boolean;
};

type ReminderStore = {
  reminders: Reminder[];
};

// 메모리에 활성 스케줄 저장
const activeSchedules: Map<string, cron.ScheduledTask> = new Map();

// 봇 인스턴스 저장 (메시지 전송용)
let botInstance: { api: { sendMessage: (chatId: number, text: string) => Promise<unknown> } } | null = null;

export function setBotInstance(bot: { api: { sendMessage: (chatId: number, text: string) => Promise<unknown> } }): void {
  botInstance = bot;
}

function getRemindersPath(): string {
  return path.join(getWorkspacePath(), "reminders.json");
}

async function loadReminders(): Promise<ReminderStore> {
  try {
    const data = await fs.readFile(getRemindersPath(), "utf-8");
    return JSON.parse(data);
  } catch {
    return { reminders: [] };
  }
}

async function saveReminders(store: ReminderStore): Promise<void> {
  await fs.writeFile(getRemindersPath(), JSON.stringify(store, null, 2));
}

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// 리마인더 실행
async function executeReminder(reminder: Reminder): Promise<void> {
  if (!botInstance) {
    console.error("Bot instance not set for reminder");
    return;
  }

  try {
    await botInstance.api.sendMessage(
      reminder.chatId,
      `⏰ 리마인더!\n\n${reminder.message}`
    );
    console.log(`[Reminder] Sent: ${reminder.message}`);

    // 일회성이면 삭제
    if (!reminder.recurring) {
      await deleteReminder(reminder.id);
    }
  } catch (error) {
    console.error("Failed to send reminder:", error);
  }
}

// 단일 리마인더 스케줄링
function scheduleReminder(reminder: Reminder): void {
  const now = new Date();
  const scheduledTime = new Date(reminder.scheduledAt);

  // 이미 지난 시간이면 스킵
  if (scheduledTime <= now && !reminder.recurring) {
    console.log(`[Reminder] Skipping past reminder: ${reminder.id}`);
    deleteReminder(reminder.id);
    return;
  }

  // 기존 스케줄 취소
  const existing = activeSchedules.get(reminder.id);
  if (existing) {
    existing.stop();
  }

  if (reminder.recurring && reminder.cronExpr) {
    // 반복 리마인더
    const task = cron.schedule(reminder.cronExpr, () => {
      executeReminder(reminder);
    });
    activeSchedules.set(reminder.id, task);
  } else {
    // 일회성 리마인더 - setTimeout 사용
    const delay = scheduledTime.getTime() - now.getTime();
    // setTimeout 최대 지연: 약 24.8일 (2^31-1 ms)
    const MAX_TIMEOUT = 2147483647;

    if (delay > 0 && delay <= MAX_TIMEOUT) {
      const timeoutId = setTimeout(() => {
        executeReminder(reminder);
        activeSchedules.delete(reminder.id);
      }, delay);

      // ScheduledTask 인터페이스 흉내
      activeSchedules.set(reminder.id, {
        stop: () => clearTimeout(timeoutId),
        start: () => {},
      } as cron.ScheduledTask);
    } else if (delay > MAX_TIMEOUT) {
      // 24일 이상은 매일 체크하여 재스케줄링
      console.log(`[Reminder] ${reminder.id} is too far in future, will re-check daily`);
      const dailyCheck = cron.schedule("0 0 * * *", () => {
        const remaining = scheduledTime.getTime() - Date.now();
        if (remaining <= MAX_TIMEOUT && remaining > 0) {
          // 이제 setTimeout 범위 내이면 재스케줄링
          dailyCheck.stop();
          activeSchedules.delete(reminder.id);
          scheduleReminder(reminder);
        }
      });
      activeSchedules.set(reminder.id, dailyCheck);
    }
  }
}

// 리마인더 생성
export async function createReminder(
  chatId: number,
  message: string,
  scheduledAt: Date,
  recurring: boolean = false,
  cronExpr?: string
): Promise<Reminder> {
  const store = await loadReminders();

  const reminder: Reminder = {
    id: generateId(),
    chatId,
    message,
    scheduledAt: scheduledAt.toISOString(),
    createdAt: new Date().toISOString(),
    recurring,
    cronExpr,
  };

  store.reminders.push(reminder);
  await saveReminders(store);

  scheduleReminder(reminder);

  return reminder;
}

// 리마인더 삭제
export async function deleteReminder(id: string): Promise<boolean> {
  const store = await loadReminders();
  const index = store.reminders.findIndex((r) => r.id === id);

  if (index === -1) return false;

  store.reminders.splice(index, 1);
  await saveReminders(store);

  const task = activeSchedules.get(id);
  if (task) {
    task.stop();
    activeSchedules.delete(id);
  }

  return true;
}

// 특정 채팅의 리마인더 목록
export async function getReminders(chatId: number): Promise<Reminder[]> {
  const store = await loadReminders();
  return store.reminders.filter((r) => r.chatId === chatId);
}

// 모든 리마인더 목록
export async function getAllReminders(): Promise<Reminder[]> {
  const store = await loadReminders();
  return store.reminders;
}

// 봇 시작 시 모든 리마인더 복원
export async function restoreReminders(): Promise<void> {
  const store = await loadReminders();
  const now = new Date();

  for (const reminder of store.reminders) {
    const scheduledTime = new Date(reminder.scheduledAt);

    // 지난 일회성 리마인더 정리
    if (!reminder.recurring && scheduledTime <= now) {
      await deleteReminder(reminder.id);
      continue;
    }

    scheduleReminder(reminder);
  }

  console.log(`[Reminder] Restored ${activeSchedules.size} reminders`);
}

// 자연어 시간 파싱 (간단 버전)
export function parseTimeExpression(expr: string): Date | null {
  const now = new Date();
  const lower = expr.toLowerCase();

  // "10분 후", "30분 뒤"
  const minMatch = lower.match(/(\d+)\s*분\s*(후|뒤)/);
  if (minMatch) {
    const mins = parseInt(minMatch[1]);
    return new Date(now.getTime() + mins * 60 * 1000);
  }

  // "1시간 후", "2시간 뒤"
  const hourMatch = lower.match(/(\d+)\s*시간\s*(후|뒤)/);
  if (hourMatch) {
    const hours = parseInt(hourMatch[1]);
    return new Date(now.getTime() + hours * 60 * 60 * 1000);
  }

  // "내일 9시", "내일 오후 3시"
  const tomorrowMatch = lower.match(/내일\s*(오전|오후)?\s*(\d{1,2})\s*시/);
  if (tomorrowMatch) {
    const isPM = tomorrowMatch[1] === "오후";
    let hour = parseInt(tomorrowMatch[2]);
    if (isPM && hour < 12) hour += 12;
    if (!isPM && hour === 12) hour = 0;

    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(hour, 0, 0, 0);
    return tomorrow;
  }

  // "오늘 9시", "오후 3시"
  const todayMatch = lower.match(/(오늘\s*)?(오전|오후)?\s*(\d{1,2})\s*시/);
  if (todayMatch) {
    const isPM = todayMatch[2] === "오후";
    let hour = parseInt(todayMatch[3]);
    if (isPM && hour < 12) hour += 12;
    if (!isPM && hour === 12) hour = 0;

    const target = new Date(now);
    target.setHours(hour, 0, 0, 0);

    // 이미 지났으면 내일
    if (target <= now) {
      target.setDate(target.getDate() + 1);
    }
    return target;
  }

  return null;
}

// 모든 스케줄 정리 (graceful shutdown)
export function cleanupReminders(): void {
  for (const [id, task] of activeSchedules) {
    task.stop();
  }
  activeSchedules.clear();
  console.log("[Reminder] Cleanup complete");
}
