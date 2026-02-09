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
  contextWindow: number;
  supportsThinking: boolean;
};

// Thinking 레벨
export type ThinkingLevel = "off" | "low" | "medium" | "high";

// Thinking 레벨별 설정
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
    supportsThinking: false,
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

// 동적 토큰 계산 설정
const MIN_OUTPUT_TOKENS = 4096;
const OUTPUT_BUFFER_RATIO = 0.3;

/**
 * 동적으로 max_tokens와 thinking budget 계산
 */
export function calculateTokenBudgets(
  modelId: ModelId,
  thinkingLevel: ThinkingLevel,
  inputTokens: number
): { maxTokens: number; thinkingBudget: number } {
  const model = MODELS[modelId];
  const thinkingConfig = THINKING_CONFIGS[thinkingLevel];

  if (!model.supportsThinking || thinkingLevel === "off") {
    return { maxTokens: 8192, thinkingBudget: 0 };
  }

  const availableOutputTokens = model.contextWindow - inputTokens;
  const maxTokens = Math.max(MIN_OUTPUT_TOKENS, Math.floor(availableOutputTokens * OUTPUT_BUFFER_RATIO));

  const calculatedBudget = Math.floor(maxTokens * thinkingConfig.ratio);
  const thinkingBudget = Math.min(
    thinkingConfig.maxBudget,
    calculatedBudget,
    maxTokens - 1024
  );

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

/**
 * Claude API 호출 (스트리밍 내부 사용, thinking 지원)
 * - 스트리밍으로 호출하되 최종 응답만 반환 (사용자에게 중간 메시지 안 보냄)
 * - thinking 활성화 가능
 * - 도구 사용 시에는 non-streaming으로 폴백 (thinking off)
 */
export async function chat(
  messages: Message[],
  systemPrompt?: string,
  modelId: ModelId = "sonnet",
  thinkingLevel: ThinkingLevel = "medium"
): Promise<ChatResult> {
  const client = getClient();
  const modelConfig = MODELS[modelId];
  const toolsUsed: ToolUseSummary[] = [];

  const apiMessages: Anthropic.MessageParam[] = messages.map((m) => ({
    role: m.role,
    content: m.content,
  }));

  // 입력 토큰 추정
  const estimateInputTokens = (): number => {
    let total = 0;
    if (systemPrompt) {
      total += Math.ceil(systemPrompt.length / 3);
    }
    for (const msg of apiMessages) {
      const content = typeof msg.content === "string" 
        ? msg.content 
        : JSON.stringify(msg.content);
      total += Math.ceil(content.length / 3);
    }
    return total;
  };

  const inputTokens = estimateInputTokens();
  const { maxTokens, thinkingBudget } = calculateTokenBudgets(modelId, thinkingLevel, inputTokens);
  
  console.log(`[Chat] model=${modelId}, thinking=${thinkingLevel}, input~${inputTokens}, maxTokens=${maxTokens}, budget=${thinkingBudget}`);

  // 스트리밍 호출 (thinking 사용 가능)
  const streamRequest = async (): Promise<Anthropic.Message> => {
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

    // thinking 활성화
    if (thinkingBudget > 0) {
      params.thinking = {
        type: "enabled",
        budget_tokens: thinkingBudget,
      };
    }

    // 스트리밍하되 최종 메시지만 반환
    const stream = client.messages.stream(params);
    return await stream.finalMessage();
  };

  // Non-streaming 호출 (도구 사용 루프용, thinking off)
  const nonStreamRequest = async (): Promise<Anthropic.Message> => {
    const params: Anthropic.MessageCreateParamsNonStreaming = {
      model: modelConfig.id,
      max_tokens: 8192,
      messages: apiMessages,
      tools: tools,
    };

    if (systemPrompt) {
      params.system = systemPrompt;
    }

    return await client.messages.create(params);
  };

  // 첫 번째 호출은 스트리밍 (thinking 사용)
  let response: Anthropic.Message;
  try {
    response = await withRetry(
      () => withTimeout(streamRequest, API_TIMEOUT_MS, "API 응답 시간 초과"),
      API_RETRY_OPTIONS
    );
  } catch (error) {
    // 스트리밍 실패 시 non-streaming 폴백
    console.log("[Chat] Streaming failed, falling back to non-streaming");
    response = await withRetry(
      () => withTimeout(nonStreamRequest, API_TIMEOUT_MS, "API 응답 시간 초과"),
      API_RETRY_OPTIONS
    );
  }

  // Tool use 루프 (non-streaming, thinking off)
  let iterations = 0;

  while (response.stop_reason === "tool_use" && iterations < MAX_TOOL_ITERATIONS) {
    iterations++;
    const toolUseBlocks = response.content.filter(
      (block): block is Anthropic.ToolUseBlock => block.type === "tool_use"
    );

    console.log(`[Tool] Executing ${toolUseBlocks.length} tool(s) in parallel`);
    
    const toolExecutions = await Promise.all(
      toolUseBlocks.map(async (toolUse) => {
        const startTime = Date.now();
        console.log(`[Tool] ${toolUse.name}:`, JSON.stringify(toolUse.input).slice(0, TOOL_INPUT_SUMMARY_LENGTH));
        
        try {
          const timeout = getToolTimeout(toolUse.name);
          const result = await Promise.race([
            executeTool(toolUse.name, toolUse.input as Record<string, unknown>),
            new Promise<string>((_, reject) => 
              setTimeout(() => reject(new Error(`Tool ${toolUse.name} timed out after ${timeout}ms`)), timeout)
            ),
          ]);
          
          const elapsed = Date.now() - startTime;
          console.log(`[Tool] ${toolUse.name} completed in ${elapsed}ms`);
          
          const compressedResult = compressToolResult(toolUse.name, result);
          
          return { toolUse, result: compressedResult, success: true };
        } catch (error) {
          const elapsed = Date.now() - startTime;
          const errorMsg = error instanceof Error ? error.message : String(error);
          console.error(`[Tool] ${toolUse.name} failed after ${elapsed}ms:`, errorMsg);
          
          return { toolUse, result: `Error: ${errorMsg}`, success: false };
        }
      })
    );

    // 도구 결과 기록
    for (const exec of toolExecutions) {
      toolsUsed.push({
        name: exec.toolUse.name,
        input: JSON.stringify(exec.toolUse.input).slice(0, TOOL_INPUT_SUMMARY_LENGTH),
        output: exec.result.slice(0, TOOL_OUTPUT_SUMMARY_LENGTH),
      });
    }

    // 어시스턴트 메시지 추가 (도구 호출)
    apiMessages.push({
      role: "assistant",
      content: response.content,
    });

    // 도구 결과 메시지 추가
    apiMessages.push({
      role: "user",
      content: toolExecutions.map((exec) => ({
        type: "tool_result" as const,
        tool_use_id: exec.toolUse.id,
        content: exec.result,
      })),
    });

    // 다음 API 호출 (non-streaming, thinking off - 도구 결과 처리)
    response = await withRetry(
      () => withTimeout(nonStreamRequest, API_TIMEOUT_MS, "API 응답 시간 초과"),
      API_RETRY_OPTIONS
    );
  }

  // 최종 텍스트 추출
  const textBlocks = response.content.filter(
    (block): block is Anthropic.TextBlock => block.type === "text"
  );
  const text = textBlocks.map((b) => b.text).join("\n");

  return { text, toolsUsed };
}

export type ChatSmartResult = {
  text: string;
  usedTools: boolean;
  toolsUsed: ToolUseSummary[];
};

/**
 * chat()의 간단한 래퍼 - 도구 사용 여부 반환
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
