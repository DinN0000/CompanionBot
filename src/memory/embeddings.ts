/**
 * 로컬 임베딩 생성 모듈
 * @xenova/transformers를 사용하여 텍스트 임베딩을 생성합니다.
 */

import { pipeline, type FeatureExtractionPipeline } from "@xenova/transformers";

// 싱글톤 파이프라인
let embeddingPipeline: FeatureExtractionPipeline | null = null;

// 모델 로딩 중인지 추적
let isLoading = false;
let loadingPromise: Promise<FeatureExtractionPipeline> | null = null;

// ============== 쿼리 임베딩 LRU 캐시 ==============
// 같은 검색 쿼리가 반복될 때 임베딩 재계산 방지
const QUERY_CACHE_MAX_SIZE = 100;
const queryEmbeddingCache = new Map<string, { embedding: number[]; lastUsed: number }>();

/**
 * LRU 방식으로 캐시 정리
 */
function pruneQueryCache(): void {
  if (queryEmbeddingCache.size <= QUERY_CACHE_MAX_SIZE) return;
  
  // lastUsed 기준 정렬하여 오래된 것 삭제
  const entries = [...queryEmbeddingCache.entries()];
  entries.sort((a, b) => a[1].lastUsed - b[1].lastUsed);
  
  const toRemove = entries.slice(0, entries.length - QUERY_CACHE_MAX_SIZE);
  for (const [key] of toRemove) {
    queryEmbeddingCache.delete(key);
  }
}

/**
 * 임베딩 파이프라인을 초기화합니다.
 * 작고 빠른 모델 사용 (384 차원)
 */
async function getEmbeddingPipeline(): Promise<FeatureExtractionPipeline> {
  if (embeddingPipeline) {
    return embeddingPipeline;
  }

  // 이미 로딩 중이면 기다림
  if (isLoading && loadingPromise) {
    return loadingPromise;
  }

  isLoading = true;
  console.log("[Embedding] Loading model...");
  const startTime = Date.now();
  
  loadingPromise = pipeline(
    "feature-extraction",
    "Xenova/all-MiniLM-L6-v2" // 384차원, 빠르고 가벼움
  );

  try {
    embeddingPipeline = await loadingPromise;
    console.log(`[Embedding] Model loaded in ${Date.now() - startTime}ms`);
    return embeddingPipeline;
  } finally {
    isLoading = false;
  }
}

/**
 * 🚀 사전 로딩: 봇 시작 시 호출하여 첫 요청 지연 방지
 */
export async function preloadEmbeddingModel(): Promise<void> {
  try {
    await getEmbeddingPipeline();
  } catch (error) {
    console.warn("[Embedding] Preload failed:", error);
  }
}

/**
 * 텍스트를 임베딩 벡터로 변환합니다.
 * LRU 캐시로 반복 쿼리 성능 향상.
 * @param text 변환할 텍스트
 * @param useCache 캐시 사용 여부 (기본 true, 청크 임베딩 시 false 권장)
 * @returns 384차원 임베딩 벡터
 */
export async function embed(text: string | null | undefined, useCache = true): Promise<number[]> {
  // null/undefined 처리
  if (text == null) {
    return new Array(384).fill(0);
  }

  // 텍스트 정규화
  const cleanText = text.trim().slice(0, 512); // 최대 512자
  if (!cleanText) {
    return new Array(384).fill(0);
  }

  // 캐시 확인
  if (useCache) {
    const cached = queryEmbeddingCache.get(cleanText);
    if (cached) {
      cached.lastUsed = Date.now();
      return cached.embedding;
    }
  }

  const pipe = await getEmbeddingPipeline();
  const result = await pipe(cleanText, {
    pooling: "mean",
    normalize: true,
  });

  // Tensor를 배열로 변환
  const embedding = Array.from(result.data as Float32Array);

  // 캐시 저장
  if (useCache) {
    queryEmbeddingCache.set(cleanText, { embedding, lastUsed: Date.now() });
    pruneQueryCache();
  }

  return embedding;
}

/**
 * 여러 텍스트를 배치로 임베딩합니다.
 * 병렬로 처리하여 성능 향상 (모델 내부에서 순차 처리되더라도 Promise 오버헤드 감소)
 * 청크용이므로 쿼리 캐시 사용 안 함 (vectorStore의 영속 캐시 사용).
 * @param texts 변환할 텍스트 배열
 * @returns 임베딩 벡터 배열
 */
export async function embedBatch(texts: (string | null | undefined)[]): Promise<number[][]> {
  // null/undefined 배열 처리
  if (!texts || texts.length === 0) return [];
  if (texts.length === 1) return [await embed(texts[0], false)];
  
  // 동시성 제한 (메모리 보호)
  const CONCURRENCY = 5;
  const results: number[][] = new Array(texts.length);
  
  for (let i = 0; i < texts.length; i += CONCURRENCY) {
    const batch = texts.slice(i, i + CONCURRENCY);
    // 청크 임베딩은 캐시 사용 안 함 (useCache=false)
    const batchResults = await Promise.all(batch.map(text => embed(text, false)));
    for (let j = 0; j < batchResults.length; j++) {
      results[i + j] = batchResults[j];
    }
  }
  
  return results;
}

/**
 * 쿼리 임베딩 캐시 통계를 반환합니다.
 */
export function getQueryCacheStats(): { size: number; maxSize: number } {
  return { size: queryEmbeddingCache.size, maxSize: QUERY_CACHE_MAX_SIZE };
}

/**
 * 쿼리 임베딩 캐시를 초기화합니다.
 */
export function clearQueryCache(): void {
  queryEmbeddingCache.clear();
}

/**
 * 두 벡터 간의 코사인 유사도를 계산합니다.
 * 
 * 최적화: embed()에서 normalize: true로 정규화된 벡터를 반환하므로,
 * 정규화된 벡터의 경우 코사인 유사도 = 내적 (norm이 1이므로)
 * normalized 파라미터가 true면 내적만 계산하여 성능 향상.
 */
export function cosineSimilarity(a: number[] | null | undefined, b: number[] | null | undefined, normalized = true): number {
  // null/undefined 또는 빈 배열 처리
  if (!a || !b || a.length === 0 || b.length === 0) return 0;
  if (a.length !== b.length) return 0;
  
  let dotProduct = 0;
  
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
  }
  
  // 정규화된 벡터면 내적 = 코사인 유사도
  if (normalized) {
    return dotProduct;
  }
  
  // 정규화되지 않은 벡터면 norm 계산 필요
  let normA = 0;
  let normB = 0;
  
  for (let i = 0; i < a.length; i++) {
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  
  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  if (denominator === 0) return 0;
  
  return dotProduct / denominator;
}
