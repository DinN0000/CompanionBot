/**
 * 봇 헬스 체크 모듈
 * 봇의 상태를 추적하고 모니터링합니다.
 * @module health
 */

import { Bot } from "grammy";
import { getWarmupStatus, type WarmupResult } from "../warmup.js";

/**
 * 워밍업 상태 정보
 */
export interface WarmupStatus {
  complete: boolean;
  inProgress: boolean;
  result: WarmupResult | null;
}

/**
 * 봇의 건강 상태 정보
 */
interface HealthStatus {
  /** 봇 가동 시간 (초) */
  uptime: number;
  /** 마지막 활동 시간 (Unix timestamp) */
  lastActivity: number;
  /** 처리한 메시지 수 */
  messageCount: number;
  /** 발생한 오류 수 */
  errorCount: number;
  /** 건강 상태 여부 (30분 이상 비활성이면 false) */
  isHealthy: boolean;
  /** 워밍업 상태 */
  warmup: WarmupStatus;
}

let startTime = Date.now();
let lastActivity = Date.now();
let messageCount = 0;
let errorCount = 0;

/**
 * 활동을 기록합니다.
 * 메시지 처리 시 호출하여 마지막 활동 시간과 메시지 카운트를 업데이트합니다.
 */
export function recordActivity(): void {
  lastActivity = Date.now();
  messageCount++;
}

/**
 * 오류 발생을 기록합니다.
 */
export function recordError(): void {
  errorCount++;
}

/**
 * 현재 봇의 건강 상태를 조회합니다.
 * @returns 건강 상태 정보
 */
export function getHealthStatus(): HealthStatus {
  const now = Date.now();
  const uptime = Math.floor((now - startTime) / 1000);
  const inactiveTime = now - lastActivity;
  
  // 30분 이상 활동 없으면 unhealthy
  const isHealthy = inactiveTime < 30 * 60 * 1000;
  
  return {
    uptime,
    lastActivity,
    messageCount,
    errorCount,
    isHealthy,
    warmup: getWarmupStatus(),
  };
}

/**
 * 가동 시간을 읽기 좋은 형태로 포맷합니다.
 * @param seconds - 가동 시간 (초)
 * @returns 포맷된 문자열 (예: "2일 3시간", "5시간 30분")
 */
export function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  
  if (days > 0) return `${days}일 ${hours}시간`;
  if (hours > 0) return `${hours}시간 ${mins}분`;
  return `${mins}분`;
}

/**
 * 헬스 상태를 초기화합니다.
 * 테스트나 재시작 시 사용합니다.
 */
export function resetHealth(): void {
  startTime = Date.now();
  lastActivity = Date.now();
  messageCount = 0;
  errorCount = 0;
}
