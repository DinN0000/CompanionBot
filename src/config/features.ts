/**
 * 기능 선택 상태 저장/로드
 * 
 * ~/.companionbot/features.json에 선택한 기능 저장
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";

// ============================================
// 타입 정의
// ============================================

export interface FeatureSelection {
  webSearch: boolean;
  calendar: boolean;
  weather: boolean;
}

// ============================================
// 기본값
// ============================================

const DEFAULT_FEATURES: FeatureSelection = {
  webSearch: false,
  calendar: false,
  weather: false,
};

// ============================================
// 경로
// ============================================

function getFeaturesDir(): string {
  return join(homedir(), ".companionbot");
}

function getFeaturesPath(): string {
  return join(getFeaturesDir(), "features.json");
}

// ============================================
// 저장/로드
// ============================================

/**
 * 기능 선택 상태 저장
 */
export function saveFeatures(features: FeatureSelection): void {
  const dir = getFeaturesDir();
  const path = getFeaturesPath();

  // 디렉토리 생성
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  // 저장
  const data = {
    ...features,
    updatedAt: new Date().toISOString(),
  };

  writeFileSync(path, JSON.stringify(data, null, 2), "utf-8");
  console.log(`[Features] 저장됨: ${path}`);
}

/**
 * 기능 선택 상태 로드
 */
export function loadFeatures(): FeatureSelection {
  const path = getFeaturesPath();

  if (!existsSync(path)) {
    return { ...DEFAULT_FEATURES };
  }

  try {
    const content = readFileSync(path, "utf-8");
    const data = JSON.parse(content);

    return {
      webSearch: data.webSearch ?? DEFAULT_FEATURES.webSearch,
      calendar: data.calendar ?? DEFAULT_FEATURES.calendar,
      weather: data.weather ?? DEFAULT_FEATURES.weather,
    };
  } catch (err) {
    console.error("[Features] 로드 실패:", err);
    return { ...DEFAULT_FEATURES };
  }
}

/**
 * 기능 활성화 여부 확인
 */
export function isFeatureEnabled(feature: keyof FeatureSelection): boolean {
  const features = loadFeatures();
  return features[feature];
}

/**
 * 모든 기능 상태 출력 (디버그용)
 */
export function logFeatures(): void {
  const features = loadFeatures();
  console.log("[Features] 현재 상태:");
  console.log(`  - 웹 검색: ${features.webSearch ? "✓" : "✗"}`);
  console.log(`  - 캘린더: ${features.calendar ? "✓" : "✗"}`);
  console.log(`  - 날씨: ${features.weather ? "✓" : "✗"}`);
}
