import * as fs from "fs/promises";
import * as path from "path";
import cron from "node-cron";
import { getWorkspacePath } from "../workspace/index.js";
import { getSecret } from "../config/secrets.js";
import { isCalendarConfigured, getTodayEvents, formatEvent } from "../calendar/index.js";

type BriefingConfig = {
  chatId: number;
  enabled: boolean;
  time: string; // "HH:MM" format
  city: string;
  timezone: string;
};

type BriefingStore = {
  configs: BriefingConfig[];
};

// 활성 스케줄
const activeJobs: Map<number, cron.ScheduledTask> = new Map();

// 봇 인스턴스
let botInstance: { api: { sendMessage: (chatId: number, text: string) => Promise<unknown> } } | null = null;

export function setBriefingBot(bot: { api: { sendMessage: (chatId: number, text: string) => Promise<unknown> } }): void {
  botInstance = bot;
}

function getConfigPath(): string {
  return path.join(getWorkspacePath(), "briefing.json");
}

async function loadStore(): Promise<BriefingStore> {
  try {
    const data = await fs.readFile(getConfigPath(), "utf-8");
    return JSON.parse(data);
  } catch {
    return { configs: [] };
  }
}

async function saveStore(store: BriefingStore): Promise<void> {
  await fs.writeFile(getConfigPath(), JSON.stringify(store, null, 2));
}

// 날씨 가져오기
async function fetchWeather(city: string): Promise<string | null> {
  const apiKey = await getSecret("openweathermap-api-key");
  if (!apiKey) return null;

  try {
    const url = `https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(city)}&appid=${apiKey}&units=metric&lang=kr`;
    const response = await fetch(url);
    const data = await response.json();

    if (data.cod !== 200) return null;

    const temp = Math.round(data.main.temp);
    const description = data.weather[0].description;
    const icon = getWeatherEmoji(data.weather[0].icon);

    return `${icon} ${city} ${temp}°C, ${description}`;
  } catch {
    return null;
  }
}

function getWeatherEmoji(iconCode: string): string {
  const map: Record<string, string> = {
    "01d": "☀️", "01n": "🌙",
    "02d": "⛅", "02n": "☁️",
    "03d": "☁️", "03n": "☁️",
    "04d": "☁️", "04n": "☁️",
    "09d": "🌧️", "09n": "🌧️",
    "10d": "🌦️", "10n": "🌧️",
    "11d": "⛈️", "11n": "⛈️",
    "13d": "❄️", "13n": "❄️",
    "50d": "🌫️", "50n": "🌫️",
  };
  return map[iconCode] || "🌤️";
}

// 브리핑 실행
async function executeBriefing(config: BriefingConfig): Promise<void> {
  if (!botInstance) {
    console.error("[Briefing] Bot instance not set");
    return;
  }

  const parts: string[] = [];

  // 인사
  const hour = new Date().getHours();
  const greeting = hour < 12 ? "좋은 아침!" : hour < 18 ? "좋은 오후!" : "좋은 저녁!";
  parts.push(`☀️ ${greeting}\n`);

  // 날씨
  const weather = await fetchWeather(config.city);
  if (weather) {
    parts.push(`🌤️ 오늘 날씨\n${weather}\n`);
  }

  // 캘린더
  const calendarConfigured = await isCalendarConfigured();
  if (calendarConfigured) {
    try {
      const events = await getTodayEvents();
      if (events.length > 0) {
        const eventList = events.slice(0, 5).map(formatEvent).join("\n• ");
        parts.push(`📅 오늘 일정\n• ${eventList}\n`);
      } else {
        parts.push(`📅 오늘 일정 없음\n`);
      }
    } catch (error) {
      console.error("[Briefing] Calendar error:", error);
    }
  }

  // 마무리
  parts.push(`좋은 하루 보내세요! 🙂`);

  const message = parts.join("\n");

  try {
    await botInstance.api.sendMessage(config.chatId, message);
    console.log(`[Briefing] Sent to ${config.chatId}`);
  } catch (error) {
    console.error("[Briefing] Send error:", error);
  }
}

// 스케줄 설정
function scheduleBriefing(config: BriefingConfig): void {
  // 기존 job 취소
  const existing = activeJobs.get(config.chatId);
  if (existing) {
    existing.stop();
    activeJobs.delete(config.chatId);
  }

  if (!config.enabled) return;

  const [hour, minute] = config.time.split(":").map(Number);
  const cronExpr = `${minute} ${hour} * * *`;

  const job = cron.schedule(cronExpr, () => {
    executeBriefing(config);
  }, {
    timezone: config.timezone,
  });

  activeJobs.set(config.chatId, job);
  console.log(`[Briefing] Scheduled for ${config.chatId} at ${config.time}`);
}

// 브리핑 설정
export async function setBriefingConfig(
  chatId: number,
  enabled: boolean,
  time: string = "08:00",
  city: string = "Seoul",
  timezone: string = "Asia/Seoul"
): Promise<BriefingConfig> {
  const store = await loadStore();

  const existingIndex = store.configs.findIndex((c) => c.chatId === chatId);
  const config: BriefingConfig = {
    chatId,
    enabled,
    time,
    city,
    timezone,
  };

  if (existingIndex >= 0) {
    store.configs[existingIndex] = config;
  } else {
    store.configs.push(config);
  }

  await saveStore(store);
  scheduleBriefing(config);

  return config;
}

// 브리핑 설정 가져오기
export async function getBriefingConfig(chatId: number): Promise<BriefingConfig | null> {
  const store = await loadStore();
  return store.configs.find((c) => c.chatId === chatId) || null;
}

// 브리핑 비활성화
export async function disableBriefing(chatId: number): Promise<void> {
  const store = await loadStore();
  const config = store.configs.find((c) => c.chatId === chatId);

  if (config) {
    config.enabled = false;
    await saveStore(store);

    const job = activeJobs.get(chatId);
    if (job) {
      job.stop();
      activeJobs.delete(chatId);
    }
  }
}

// 모든 브리핑 복원 (봇 시작 시)
export async function restoreBriefings(): Promise<void> {
  const store = await loadStore();

  for (const config of store.configs) {
    if (config.enabled) {
      scheduleBriefing(config);
    }
  }

  console.log(`[Briefing] Restored ${activeJobs.size} briefings`);
}

// 즉시 브리핑 실행 (테스트용)
export async function sendBriefingNow(chatId: number): Promise<boolean> {
  const config = await getBriefingConfig(chatId);

  if (!config) {
    // 기본 설정으로 실행
    const defaultConfig: BriefingConfig = {
      chatId,
      enabled: false,
      time: "08:00",
      city: "Seoul",
      timezone: "Asia/Seoul",
    };
    await executeBriefing(defaultConfig);
    return true;
  }

  await executeBriefing(config);
  return true;
}
