/**
 * Token estimation utilities
 * 
 * Claude roughly uses:
 * - English: ~4 chars per token
 * - Korean: ~1.5 tokens per char (한글은 토큰이 더 많이 필요함)
 * 
 * These are rough estimates for context management, not exact counts.
 */

import {
  TOKENS_PER_KOREAN_CHAR,
  CHARS_PER_TOKEN_OTHER,
  MESSAGE_TOKEN_OVERHEAD,
} from "./constants.js";

export interface MessageLike {
  content: string | unknown;
  role?: string;
}

/**
 * Estimate token count for a text string
 * 한글은 보수적으로 계산 (실제보다 약간 높게)
 */
export function estimateTokens(text: string): number {
  // 자모음까지 포함하는 넓은 범위의 한글 매칭
  const koreanChars = (text.match(/[\u3131-\uD79D]/g) || []).length;
  const otherChars = text.length - koreanChars;
  return Math.ceil(koreanChars * TOKENS_PER_KOREAN_CHAR + otherChars / CHARS_PER_TOKEN_OTHER);
}

/**
 * Estimate token count for an array of messages
 */
export function estimateMessagesTokens(messages: MessageLike[]): number {
  return messages.reduce((sum, msg) => {
    const content = typeof msg.content === 'string' 
      ? msg.content 
      : JSON.stringify(msg.content);
    return sum + estimateTokens(content) + MESSAGE_TOKEN_OVERHEAD;
  }, 0);
}
