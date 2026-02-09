/**
 * Token estimation utilities
 * 
 * Claude roughly uses:
 * - English: ~4 chars per token
 * - Korean: ~1.5 tokens per char (한글은 토큰이 더 많이 필요함)
 * 
 * These are rough estimates for context management, not exact counts.
 */

export interface MessageLike {
  content: string | unknown;
  role?: string;
}

/**
 * Estimate token count for a text string
 * 한글은 보수적으로 1.5 토큰/글자로 계산 (실제보다 약간 높게)
 */
export function estimateTokens(text: string): number {
  // 자모음까지 포함하는 넓은 범위의 한글 매칭
  const koreanChars = (text.match(/[\u3131-\uD79D]/g) || []).length;
  const otherChars = text.length - koreanChars;
  return Math.ceil(koreanChars * 1.5 + otherChars / 4);
}

/**
 * Estimate token count for an array of messages
 */
export function estimateMessagesTokens(messages: MessageLike[]): number {
  return messages.reduce((sum, msg) => {
    const content = typeof msg.content === 'string' 
      ? msg.content 
      : JSON.stringify(msg.content);
    return sum + estimateTokens(content) + 4; // 메시지 오버헤드
  }, 0);
}
