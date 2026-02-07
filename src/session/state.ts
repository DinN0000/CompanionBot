import type { ModelId } from "../ai/claude.js";
import type { Message } from "../ai/claude.js";

// 세션 설정
const MAX_SESSIONS = 100;
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24시간

type SessionData = {
  history: Message[];
  model: ModelId;
  lastAccessedAt: number;
};

// 세션별 상태 저장
const sessions = new Map<number, SessionData>();

function getSession(chatId: number): SessionData {
  const existing = sessions.get(chatId);
  const now = Date.now();

  if (existing) {
    existing.lastAccessedAt = now;
    return existing;
  }

  // 새 세션 생성 전 정리
  cleanupSessions();

  const session: SessionData = {
    history: [],
    model: "sonnet",
    lastAccessedAt: now,
  };
  sessions.set(chatId, session);
  return session;
}

function cleanupSessions(): void {
  const now = Date.now();

  // 1. TTL 만료된 세션 삭제
  for (const [chatId, session] of sessions) {
    if (now - session.lastAccessedAt > SESSION_TTL_MS) {
      sessions.delete(chatId);
    }
  }

  // 2. 최대 개수 초과 시 LRU 방식으로 삭제
  if (sessions.size >= MAX_SESSIONS) {
    const entries = Array.from(sessions.entries());
    entries.sort((a, b) => a[1].lastAccessedAt - b[1].lastAccessedAt);

    const toRemove = entries.slice(0, sessions.size - MAX_SESSIONS + 1);
    for (const [chatId] of toRemove) {
      sessions.delete(chatId);
    }
  }
}

export function getHistory(chatId: number): Message[] {
  return getSession(chatId).history;
}

export function clearHistory(chatId: number): void {
  sessions.delete(chatId);
}

export function getModel(chatId: number): ModelId {
  return getSession(chatId).model;
}

export function setModel(chatId: number, modelId: ModelId): void {
  getSession(chatId).model = modelId;
}

// 현재 활성 chatId (도구에서 사용)
let currentChatId: number | null = null;

export function setCurrentChatId(chatId: number): void {
  currentChatId = chatId;
}

export function getCurrentChatId(): number | null {
  return currentChatId;
}

// 세션 정리 (수동 호출용)
export function cleanupExpiredSessions(): number {
  const before = sessions.size;
  cleanupSessions();
  return before - sessions.size;
}

// 현재 세션 수 조회
export function getSessionCount(): number {
  return sessions.size;
}
