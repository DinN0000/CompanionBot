/**
 * 🚀 Warmup 모듈
 * 
 * 봇 시작 시 콜드 스타트 지연을 최소화하기 위해
 * 무거운 작업들을 백그라운드에서 미리 수행합니다.
 * 
 * 사용법:
 *   import { warmup, getWarmupStatus } from "./warmup.js";
 *   await warmup(); // 또는 warmup().catch(console.error)로 백그라운드 실행
 */

import { preloadEmbeddingModel } from "./memory/embeddings.js";
import { preloadWorkspace } from "./telegram/utils/cache.js";
import { loadAllMemoryChunks } from "./memory/vectorStore.js";

export interface WarmupResult {
  total: number;
  embedding: number;
  workspace: number;
  memory: number;
  success: boolean;
  errors: string[];
}

// 워밍업 상태 추적
let warmupComplete = false;
let warmupResult: WarmupResult | null = null;
let warmupPromise: Promise<WarmupResult> | null = null;

/**
 * 🚀 콜드 스타트 최적화를 위한 사전 로딩
 * 
 * 다음 작업들을 병렬로 수행합니다:
 * 1. 임베딩 모델 로딩 (가장 무거움, ~3-5초)
 * 2. 워크스페이스 파일 로딩 (~100-300ms)
 * 3. 메모리 청크 로딩 (~200-500ms)
 * 
 * @returns 각 작업의 소요 시간 정보
 */
export async function warmup(): Promise<WarmupResult> {
  // 이미 완료되었으면 캐시된 결과 반환
  if (warmupComplete && warmupResult) {
    return warmupResult;
  }

  // 이미 진행 중이면 해당 Promise 반환
  if (warmupPromise) {
    return warmupPromise;
  }

  const startTime = Date.now();
  console.log("[Warmup] Starting cold start optimization...");

  warmupPromise = doWarmup(startTime);
  
  try {
    warmupResult = await warmupPromise;
    warmupComplete = true;
    return warmupResult;
  } finally {
    warmupPromise = null;
  }
}

async function doWarmup(startTime: number): Promise<WarmupResult> {
  const errors: string[] = [];
  const times = {
    embedding: 0,
    workspace: 0,
    memory: 0,
  };

  // 병렬로 모든 preload 수행
  const results = await Promise.allSettled([
    // 1. 임베딩 모델 (가장 무거움)
    (async () => {
      const t = Date.now();
      await preloadEmbeddingModel();
      times.embedding = Date.now() - t;
    })(),
    
    // 2. 워크스페이스 파일
    (async () => {
      const t = Date.now();
      await preloadWorkspace();
      times.workspace = Date.now() - t;
    })(),
    
    // 3. 메모리 청크 (임베딩 캐시 로드 포함)
    (async () => {
      const t = Date.now();
      await loadAllMemoryChunks();
      times.memory = Date.now() - t;
    })(),
  ]);

  // 에러 수집
  for (const [idx, result] of results.entries()) {
    if (result.status === "rejected") {
      const taskNames = ["embedding", "workspace", "memory"];
      errors.push(`${taskNames[idx]}: ${result.reason}`);
    }
  }

  const total = Date.now() - startTime;
  const success = errors.length === 0;

  console.log(
    `[Warmup] Complete in ${total}ms ` +
    `(embedding: ${times.embedding}ms, workspace: ${times.workspace}ms, memory: ${times.memory}ms)` +
    (errors.length > 0 ? ` - ${errors.length} error(s)` : "")
  );

  return {
    total,
    embedding: times.embedding,
    workspace: times.workspace,
    memory: times.memory,
    success,
    errors,
  };
}

/**
 * 워밍업 완료 여부를 반환합니다.
 */
export function isWarmupComplete(): boolean {
  return warmupComplete;
}

/**
 * 워밍업 결과를 반환합니다.
 * 아직 완료되지 않았으면 null
 */
export function getWarmupResult(): WarmupResult | null {
  return warmupResult;
}

/**
 * 워밍업 상태를 반환합니다. (디버그/헬스체크용)
 */
export function getWarmupStatus(): {
  complete: boolean;
  inProgress: boolean;
  result: WarmupResult | null;
} {
  return {
    complete: warmupComplete,
    inProgress: warmupPromise !== null,
    result: warmupResult,
  };
}
