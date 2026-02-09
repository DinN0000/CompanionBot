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
  _thinkingLevel?: ThinkingLevel  // 사용 안 함 (non-streaming에서 에러 발생)
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

  // 토큰 계산 (thinking 비활성화 - non-streaming에서 에러 발생)
  const inputTokens = estimateInputTokens();
  const maxTokens = 8192;
  
  console.log(`[Chat] model=${modelId}, input~${inputTokens}, maxTokens=${maxTokens}`);

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

/**
 * 스마트 채팅 - chat()의 단순 래퍼
 * 
 * 도구 사용 여부를 별도로 반환하여 호출자가 구분할 수 있게 함
 */
export async function chatSmart(
  messages: Message[],
  systemPrompt: string,
  modelId: ModelId,
  thinkingLevel: ThinkingLevel = "medium"
): Promise<ChatSmartResult> {
  const result = await chat(messages, systemPrompt, modelId, thinkingLevel);
  return { 
    text: result.text, 
    usedTools: result.toolsUsed.length > 0, 
    toolsUsed: result.toolsUsed 
  };
}
