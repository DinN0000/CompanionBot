/**
 * 설정 파일 로더
 * config.json에서 사용자 설정을 읽음
 */
import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = resolve(__dirname, "../../config.json");

export type ThinkingLevel = "off" | "low" | "medium" | "high";

type Config = {
  thinking: ThinkingLevel;
};

const DEFAULT_CONFIG: Config = {
  thinking: "medium",
};

let cachedConfig: Config | null = null;

export function loadConfig(): Config {
  if (cachedConfig) return cachedConfig;

  if (!existsSync(CONFIG_PATH)) {
    console.log("[Config] config.json not found, using defaults");
    cachedConfig = DEFAULT_CONFIG;
    return cachedConfig;
  }

  try {
    const raw = readFileSync(CONFIG_PATH, "utf-8");
    const parsed = JSON.parse(raw) as Partial<Config>;
    cachedConfig = {
      thinking: parsed.thinking ?? DEFAULT_CONFIG.thinking,
    };
    console.log(`[Config] Loaded: thinking=${cachedConfig.thinking}`);
    return cachedConfig;
  } catch (error) {
    console.error("[Config] Failed to load config.json:", error);
    cachedConfig = DEFAULT_CONFIG;
    return cachedConfig;
  }
}

export function getConfig(): Config {
  return cachedConfig ?? loadConfig();
}
