import Anthropic, { APIError } from "@anthropic-ai/sdk";
import { tools, executeTool } from "../tools/index.js";
import { 
  MAX_TOOL_ITERATIONS,
  TOOL_INPUT_SUMMARY_LENGTH,
  TOOL_OUTPUT_SUMMARY_LENGTH,
} from "../utils/constants.js";
import {
  withRetry,
  withTimeout,
  isTransientError,
  formatErrorForUser,
  type RetryOptions,
} from "../utils/retry.js";
import { getToolTimeout } from "../tools/timeout.js";
import { compressToolResult } from "../tools/compress.js";

// API 호출 타임아웃 (2분) - Claude의 긴 응답 시간 고려
const API_TIMEOUT_MS = 120000;

// 재시도 설정
const API_RETRY_OPTIONS: RetryOptions = {
  maxRetries: 3,
  initialDelayMs: 1000,
  maxDelayMs: 30000,
  onRetry: (attempt, error, delay) => {
    const errMsg = error instanceof Error ? error.message : String(error);
    console.log(`[API Retry] Attempt ${attempt}, waiting ${delay}ms: ${errMsg.slice(0, 100)}`);
  },
};

let anthropic: Anthropic | null = null;

function getClient(): Anthropic {
  if (!anthropic) {
    anthropic = new Anthropic();
  }
  return anthropic;
}

export type Message = {
  role: "user" | "assistant";
  content: string | Anthropic.ContentBlock[] | Anthropic.ContentBlockParam[];
};

export type ImageData = {
  base64: string;
  mediaType: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
};

export type ModelId = "sonnet" | "opus" | "haiku";

export type ModelConfig = {
  id: string;
  name: string;
  contextWindow: number;  // 모델 전체 컨텍스트 윈도우
  supportsThinking: boolean;
};

// Thinking 레벨: off/low/medium/high
export type ThinkingLevel = "off" | "low" | "medium" | "high";

// Thinking 레벨별 설정 (비율 및 최대값)
export const THINKING_CONFIGS: Record<ThinkingLevel, { ratio: number; maxBudget: number }> = {
  off: { ratio: 0, maxBudget: 0 },
  low: { ratio: 0.3, maxBudget: 5000 },
  medium: { ratio: 0.5, maxBudget: 10000 },
  high: { ratio: 0.7, maxBudget: 20000 },
};

// 모델별 설정
export const MODELS: Record<ModelId, ModelConfig> = {
  haiku: {
    id: "claude-haiku-3-5-20241022",
    name: "Claude Haiku 3.5",
    contextWindow: 200000,
    supportsThinking: false,  // Haiku는 thinking 미지원
  },
  sonnet: {
    id: "claude-sonnet-4-20250514",
    name: "Claude Sonnet 4",
    contextWindow: 200000,
    supportsThinking: true,
  },
  opus: {
    id: "claude-opus-4-20250514",
    name: "Claude Opus 4",
    contextWindow: 200000,
    supportsThinking: true,
  },
};

// 동적 토큰 계산을 위한 설정
const MIN_OUTPUT_TOKENS = 4096;  // 최소 출력 토큰
const OUTPUT_BUFFER_RATIO = 0.3;  // 컨텍스트의 30%를 출력용으로 예약

/**
 * 동적으로 max_tokens와 thinking budget 계산
 * 
 * @param modelId 모델 ID
 * @param thinkingLevel thinking 레벨
 * @param inputTokens 현재 입력 토큰 수 (시스템 프롬프트 + 히스토리)
 * @returns { maxTokens, thinkingBudget }
 */
export function calculateTokenBudgets(
  modelId: ModelId,
  thinkingLevel: ThinkingLevel,
  inputTokens: number
): { maxTokens: number; thinkingBudget: number } {
  const model = MODELS[modelId];
  const thinkingConfig = THINKING_CONFIGS[thinkingLevel];

  // Thinking 미지원 모델이거나 off인 경우
  if (!model.supportsThinking || thinkingLevel === "off") {
    // 간단히 고정 max_tokens 사용
    return { maxTokens: 8192, thinkingBudget: 0 };
  }

  // 사용 가능한 출력 토큰 계산
  // 컨텍스트 윈도우 - 입력 토큰 = 출력 가능 토큰
  const availableOutputTokens = model.contextWindow - inputTokens;
  
  // 최소 출력 토큰 보장
  const maxTokens = Math.max(MIN_OUTPUT_TOKENS, Math.floor(availableOutputTokens * OUTPUT_BUFFER_RATIO));

  // thinking budget 계산: min(레벨별 최대값, max_tokens * 비율)
  // API 조건: max_tokens > budget_tokens 이므로 max_tokens - 1024 로 상한 설정
  const calculatedBudget = Math.floor(maxTokens * thinkingConfig.ratio);
  const thinkingBudget = Math.min(
    thinkingConfig.maxBudget,
    calculatedBudget,
    maxTokens - 1024  // max_tokens > budget_tokens 조건 충족
  );

  // budget이 1024 미만이면 thinking 비활성화 (의미 없음)
  if (thinkingBudget < 1024) {
    return { maxTokens, thinkingBudget: 0 };
  }

  return { maxTokens, thinkingBudget };
}

export type ToolUseSummary = {
  name: string;
  input: string;
  output: string;
};

export type ChatResult = {
  text: string;
  toolsUsed: ToolUseSummary[];
};

export async function chat(
  messages: Message[],
  systemPrompt?: string,
  modelId: ModelId = "sonnet",
  thinkingLevel: ThinkingLevel = "medium"
): Promise<ChatResult> {
  const client = getClient();
  const modelConfig = MODELS[modelId];
  const toolsUsed: ToolUseSummary[] = [];

  // 메시지를 API 형식으로 변환
  const apiMessages: Anthropic.MessageParam[] = messages.map((m) => ({
    role: m.role,
    content: m.content,
  }));

  // 입력 토큰 추정 (대략적)
  const estimateInputTokens = (): number => {
    let total = 0;
    // 시스템 프롬프트
    if (systemPrompt) {
      total += Math.ceil(systemPrompt.length / 3); // 대략 3자당 1토큰
    }
    // 메시지들
    for (const msg of apiMessages) {
      const content = typeof msg.content === "string" 
        ? msg.content 
        : JSON.stringify(msg.content);
      total += Math.ceil(content.length / 3);
    }
    return total;
  };

  // 동적 토큰 budget 계산
  const inputTokens = estimateInputTokens();
  const { maxTokens, thinkingBudget } = calculateTokenBudgets(modelId, thinkingLevel, inputTokens);
  
  console.log(`[Chat] model=${modelId}, thinking=${thinkingLevel}, input~${inputTokens}, maxTokens=${maxTokens}, budget=${thinkingBudget}`);

  // API 요청 파라미터 빌드 (도구 루프에서도 동일하게 사용)
  const buildRequestParams = (): Anthropic.MessageCreateParamsNonStreaming => {
    const params: Anthropic.MessageCreateParamsNonStreaming = {
      model: modelConfig.id,
      max_tokens: maxTokens,
      messages: apiMessages,
      tools: tools,
    };

    if (systemPrompt) {
      params.system = systemPrompt;
    }

    // thinking 활성화 (budget > 0인 경우)
    if (thinkingBudget > 0) {
      params.thinking = {
        type: "enabled",
        budget_tokens: thinkingBudget,
      };
    }

    return params;
  };

  let response: Anthropic.Message;
  response = await withRetry(
    () => withTimeout(
      () => client.messages.create(buildRequestParams()),
      API_TIMEOUT_MS,
      "API 응답 시간 초과"
    ),
    API_RETRY_OPTIONS
  );

  // Tool use 루프 - Claude가 도구 사용을 멈출 때까지 반복
  let iterations = 0;

  while (response.stop_reason === "tool_use" && iterations < MAX_TOOL_ITERATIONS) {
    iterations++;
    const toolUseBlocks = response.content.filter(
      (block): block is Anthropic.ToolUseBlock => block.type === "tool_use"
    );

    // 도구 병렬 실행 (성능 최적화)
    console.log(`[Tool] Executing ${toolUseBlocks.length} tool(s) in parallel`);
    
    const toolExecutions = await Promise.all(
      toolUseBlocks.map(async (toolUse) => {
        const startTime = Date.now();
        console.log(`[Tool] ${toolUse.name}:`, JSON.stringify(toolUse.input).slice(0, 200));
        
        try {
          // 도구별 타임아웃 적용
          const timeout = getToolTimeout(toolUse.name);
          const result = await Promise.race([
            executeTool(toolUse.name, toolUse.input as Record<string, unknown>),
            new Promise<string>((_, reject) => 
              setTimeout(() => reject(new Error(`Tool ${toolUse.name} timed out after ${timeout}ms`)), timeout)
            ),
          ]);
          
          const elapsed = Date.now() - startTime;
          console.log(`[Tool] ${toolUse.name} completed in ${elapsed}ms`);
          
          // 스마트 결과 압축
          const compressedResult = compressToolResult(toolUse.name, result);
          
          return {
            toolUse,
            result: compressedResult,
            success: true,
          };
        } catch (error) {
          const elapsed = Date.now() - startTime;
          const errorMsg = error instanceof Error ? error.message : String(error);
          console.error(`[Tool] ${toolUse.name} failed after ${elapsed}ms:`, errorMsg);
          
          return {
            toolUse,
            result: `Error: ${errorMsg}`,
            success: false,
          };
        }
      })
    );
    
    // 결과 수집
    const toolResults: Anthropic.ToolResultBlockParam[] = toolExecutions.map((exec) => ({
      type: "tool_result" as const,
      tool_use_id: exec.toolUse.id,
      content: exec.result,
    }));
    
    // 도구 사용 기록
    for (const exec of toolExecutions) {
      toolsUsed.push({
        name: exec.toolUse.name,
        input: JSON.stringify(exec.toolUse.input).slice(0, TOOL_INPUT_SUMMARY_LENGTH),
        output: exec.result.slice(0, TOOL_OUTPUT_SUMMARY_LENGTH),
      });
    }

    // 어시스턴트 메시지와 도구 결과 추가
    apiMessages.push({
      role: "assistant",
      content: response.content,
    });

    apiMessages.push({
      role: "user",
      content: toolResults,
    });

    // 다음 응답 요청 (도구 루프에서도 thinking 유지)
    response = await withRetry(
      () => withTimeout(
        () => client.messages.create(buildRequestParams()),
        API_TIMEOUT_MS,
        "API 응답 시간 초과"
      ),
      API_RETRY_OPTIONS
    );
  }

  // 반복 횟수 초과 시 경고
  if (iterations >= MAX_TOOL_ITERATIONS) {
    console.warn(`[Warning] Tool use loop reached max iterations (${MAX_TOOL_ITERATIONS})`);
    return { text: "도구 실행이 너무 많이 반복됐어. 다시 시도해줄래?", toolsUsed };
  }

  // 최종 텍스트 응답 추출
  const textBlock = response.content.find(
    (block): block is Anthropic.TextBlock => block.type === "text"
  );

  return { 
    text: textBlock?.text ?? "응답을 생성하지 못했어. 다시 시도해줄래?",
    toolsUsed
  };
}

export type ChatSmartResult = {
  text: string;
  usedTools: boolean;
  toolsUsed: ToolUseSummary[];
};

export type StreamCallbacks = {
  onChunk?: (text: string, accumulated: string) => void | Promise<void>;
  onToolStart?: (toolNames: string[]) => void | Promise<void>;
};

/**
 * 스마트 채팅 - 가능하면 스트리밍, 도구 필요하면 일반 호출
 * 
 * 전략:
 * - 먼저 스트리밍으로 시도
 * - 도구 호출이 감지되면 (stop_reason === "tool_use") 기존 chat()으로 폴백
 * - 스트리밍은 최종 텍스트 응답에만 사용
 * 
 * 주의: 스트리밍은 재시도하지 않음 (이미 전송된 청크를 되돌릴 수 없음)
 * 스트리밍 중 에러 발생 시 적절한 에러 메시지를 반환하거나 예외를 전파함
 */
export async function chatSmart(
  messages: Message[],
  systemPrompt: string,
  modelId: ModelId,
  thinkingLevel: ThinkingLevel = "medium",
  onChunk?: ((text: string, accumulated: string) => void | Promise<void>) | StreamCallbacks
): Promise<ChatSmartResult> {
  // 콜백 정규화
  const callbacks: StreamCallbacks = typeof onChunk === 'function' 
    ? { onChunk } 
    : (onChunk ?? {});
  // 스트리밍 콜백이 없으면 그냥 일반 chat 사용
  if (!callbacks.onChunk) {
    const result = await chat(messages, systemPrompt, modelId, thinkingLevel);
    return { text: result.text, usedTools: result.toolsUsed.length > 0, toolsUsed: result.toolsUsed };
  }

  const client = getClient();
  const modelConfig = MODELS[modelId];

  // 메시지를 API 형식으로 변환
  const apiMessages: Anthropic.MessageParam[] = messages.map((m) => ({
    role: m.role,
    content: m.content,
  }));

  // 입력 토큰 추정
  let inputTokens = 0;
  if (systemPrompt) {
    inputTokens += Math.ceil(systemPrompt.length / 3);
  }
  for (const msg of apiMessages) {
    const content = typeof msg.content === "string" 
      ? msg.content 
      : JSON.stringify(msg.content);
    inputTokens += Math.ceil(content.length / 3);
  }

  // 동적 토큰 budget 계산
  const { maxTokens, thinkingBudget } = calculateTokenBudgets(modelId, thinkingLevel, inputTokens);
  
  console.log(`[ChatSmart] model=${modelId}, thinking=${thinkingLevel}, input~${inputTokens}, maxTokens=${maxTokens}, budget=${thinkingBudget}`);

  // 스트리밍 요청 파라미터
  const params: Anthropic.MessageCreateParamsStreaming = {
    model: modelConfig.id,
    max_tokens: maxTokens,
    messages: apiMessages,
    tools: tools,
    stream: true,
  };

  if (systemPrompt) {
    params.system = systemPrompt;
  }

  // Thinking 활성화 (스트리밍에서도 지원)
  if (thinkingBudget > 0) {
    params.thinking = {
      type: "enabled",
      budget_tokens: thinkingBudget,
    };
  }

  let accumulated = "";
  let streamingStarted = false;

  try {
    const stream = client.messages.stream(params);

    // 스트리밍 이벤트 처리
    stream.on("text", async (text) => {
      streamingStarted = true;
      accumulated += text;
      try {
        await callbacks.onChunk!(text, accumulated);
      } catch (err) {
        // editMessageText 실패 등은 무시하고 계속
        console.warn("[Stream] Chunk callback error (ignored):", err);
      }
    });

    // 스트림 완료 대기
    const finalMessage = await stream.finalMessage();
    const stopReason = finalMessage.stop_reason;

    // 도구 호출이 필요한 경우 - 일반 chat으로 폴백
    // 주의: chat()은 내부에서 withRetry를 사용하므로 여기서 추가 재시도 불필요
    if (stopReason === "tool_use") {
      console.log("[Stream] Tool use detected, falling back to chat()");
      
      // 도구 이름 추출하여 콜백 호출
      const toolUseBlocks = finalMessage.content.filter(
        (block): block is Anthropic.ToolUseBlock => block.type === "tool_use"
      );
      const toolNames = toolUseBlocks.map(t => t.name);
      
      if (callbacks.onToolStart && toolNames.length > 0) {
        try {
          await callbacks.onToolStart(toolNames);
        } catch (err) {
          console.warn("[Stream] Tool start callback error (ignored):", err);
        }
      }
      
      // 도구 사용 시 thinking 비활성화 (API 에러 방지)
      const result = await chat(messages, systemPrompt, modelId, "off");
      return { text: result.text, usedTools: true, toolsUsed: result.toolsUsed };
    }

    // 성공적으로 스트리밍 완료
    return { text: accumulated, usedTools: false, toolsUsed: [] };
  } catch (error: unknown) {
    // 스트리밍 시작 전 에러 (연결 실패 등) - 재시도 가능
    if (!streamingStarted && error instanceof APIError) {
      // Rate limit 또는 서버 에러는 withRetry로 재시도
      if (error.status === 429 || error.status >= 500) {
        console.log(`[Stream] Pre-stream error (${error.status}), retrying with withRetry...`);
        return await withRetry(async () => {
          // 재시도 시 일반 chat 사용 (스트리밍 대신, thinking 비활성화)
          const result = await chat(messages, systemPrompt, modelId, "off");
          return { text: result.text, usedTools: false, toolsUsed: result.toolsUsed };
        });
      }
    }

    // 스트리밍 중 에러 - 재시도 불가 (이미 청크가 전송됨)
    if (streamingStarted) {
      console.error("[Stream] Error during streaming (cannot retry):", error);
      // 이미 일부 텍스트가 전송됐으므로, 에러 메시지를 추가하거나 부분 결과 반환
      if (accumulated.length > 0) {
        return { 
          text: accumulated + "\n\n(응답 생성 중 오류 발생)", 
          usedTools: false,
          toolsUsed: []
        };
      }
    }

    // 그 외 에러는 전파
    throw error;
  }
}
