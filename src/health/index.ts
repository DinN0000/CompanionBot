import { Bot } from "grammy";

interface HealthStatus {
  uptime: number;        // 초
  lastActivity: number;  // timestamp
  messageCount: number;
  errorCount: number;
  isHealthy: boolean;
}

let startTime = Date.now();
let lastActivity = Date.now();
let messageCount = 0;
let errorCount = 0;

export function recordActivity(): void {
  lastActivity = Date.now();
  messageCount++;
}

export function recordError(): void {
  errorCount++;
}

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
    isHealthy
  };
}

export function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  
  if (days > 0) return `${days}일 ${hours}시간`;
  if (hours > 0) return `${hours}시간 ${mins}분`;
  return `${mins}분`;
}

export function resetHealth(): void {
  startTime = Date.now();
  lastActivity = Date.now();
  messageCount = 0;
  errorCount = 0;
}
