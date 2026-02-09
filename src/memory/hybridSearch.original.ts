/**
 * 하이브리드 검색 모듈
 * 벡터 검색 + 키워드 검색을 결합하여 최적의 검색 결과를 제공합니다.
 * 
 * 에러 처리 전략:
 * - 벡터/키워드 검색 중 하나만 성공해도 결과 반환 (graceful degradation)
 * - 임베딩 실패 시 키워드 검색만으로 폴백
 * - 전체 타임아웃으로 검색 지연 방지
 */

import { embed } from "./embeddings.js";
import { search as vectorSearch, type SearchResult } from "./vectorStore.js";
import { searchKeyword, type FtsSearchResult } from "./ftsIndex.js";
import { withTimeout, withFallback } from "../utils/retry.js";

// 검색 타임아웃 (5초)
const SEARCH_TIMEOUT_MS = 5000;
// 임베딩 타임아웃 (3초)
const EMBED_TIMEOUT_MS = 3000;

// 가중치 설정
const VECTOR_WEIGHT = 0.7;
const KEYWORD_WEIGHT = 0.3;

export interface HybridSearchResult {
  text: string;
  source: string;
  score: number;
  vectorScore?: number;
  keywordScore?: number;
}

/**
 * BM25 점수를 0-1 범위로 정규화합니다.
 * BM25는 낮을수록 관련성이 높으므로 반전시킵니다.
 */
function normalizeBm25Score(score: number, minScore: number, maxScore: number): number {
  if (maxScore === minScore) return 1;
  // BM25는 음수 (낮을수록 좋음) → 정규화 후 반전
  const normalized = (maxScore - score) / (maxScore - minScore);
  return Math.max(0, Math.min(1, normalized));
}

/**
 * 벡터 + 키워드 하이브리드 검색을 수행합니다.
 * 
 * Graceful Degradation:
 * - 임베딩 실패 시 키워드 검색만 수행
 * - 벡터 검색 실패 시 키워드 검색만으로 결과 반환
 * - 전체 타임아웃으로 검색 지연 방지
 * 
 * @param query 검색 쿼리
 * @param topK 반환할 최대 결과 수
 * @param vectorWeight 벡터 검색 가중치 (기본 0.7)
 * @param keywordWeight 키워드 검색 가중치 (기본 0.3)
 */
export async function hybridSearch(
  query: string,
  topK: number = 5,
  vectorWeight: number = VECTOR_WEIGHT,
  keywordWeight: number = KEYWORD_WEIGHT
): Promise<HybridSearchResult[]> {
  // 🚀 병렬 실행: 키워드 검색 + (임베딩 → 벡터 검색)
  const keywordPromise = Promise.resolve().then(() => {
    try {
      return searchKeyword(query, topK * 2);
    } catch (error) {
      console.warn("[HybridSearch] Keyword search failed:", error);
      return [] as FtsSearchResult[];
    }
  });

  const vectorPromise = (async () => {
    // 임베딩 생성 (타임아웃 + 폴백)
    const queryEmbedding = await withFallback(
      () => withTimeout(() => embed(query), EMBED_TIMEOUT_MS, "임베딩 생성 시간 초과"),
      null,
      {
        onError: (error) => {
          console.warn("[HybridSearch] Embedding failed, using keyword-only:", error);
        },
      }
    ) as number[] | null;

    // 벡터 검색 수행 (임베딩 성공 시만)
    if (!queryEmbedding) return [] as SearchResult[];
    
    return await withFallback(
      () => withTimeout(
        () => vectorSearch(queryEmbedding, topK * 2, 0.2),
        SEARCH_TIMEOUT_MS,
        "벡터 검색 시간 초과"
      ),
      [],
      {
        onError: (error) => {
          console.warn("[HybridSearch] Vector search failed:", error);
        },
      }
    ) as SearchResult[];
  })();

  // 병렬 실행 완료 대기
  const [keywordResults, vectorResults] = await Promise.all([keywordPromise, vectorPromise]);

  // 결과가 모두 없으면 빈 배열 반환
  if (vectorResults.length === 0 && keywordResults.length === 0) {
    return [];
  }

  // 점수 병합을 위한 Map (key: text의 hash)
  const scoreMap = new Map<string, HybridSearchResult>();

  // 벡터 결과 처리 (코사인 유사도: 이미 0-1 범위)
  for (const result of vectorResults) {
    const key = makeKey(result.text, result.source);
    scoreMap.set(key, {
      text: result.text,
      source: result.source,
      score: result.score * vectorWeight,
      vectorScore: result.score,
    });
  }

  // 키워드 결과 정규화 및 병합
  if (keywordResults.length > 0) {
    const minBm25 = Math.min(...keywordResults.map(r => r.score));
    const maxBm25 = Math.max(...keywordResults.map(r => r.score));

    for (const result of keywordResults) {
      const key = makeKey(result.text, result.source);
      const normalizedScore = normalizeBm25Score(result.score, minBm25, maxBm25);

      const existing = scoreMap.get(key);
      if (existing) {
        // 이미 벡터 결과에 있으면 점수 합산
        existing.score += normalizedScore * keywordWeight;
        existing.keywordScore = normalizedScore;
      } else {
        // 새로운 결과
        scoreMap.set(key, {
          text: result.text,
          source: result.source,
          score: normalizedScore * keywordWeight,
          keywordScore: normalizedScore,
        });
      }
    }
  }

  // 점수 기준 정렬 후 상위 K개 반환
  const results = Array.from(scoreMap.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);

  return results;
}

/**
 * 벡터 검색만 수행합니다. (기존 동작 호환)
 * 실패 시 빈 배열 반환 (graceful degradation)
 */
export async function searchVector(
  query: string,
  topK: number = 5,
  minScore: number = 0.3
): Promise<SearchResult[]> {
  try {
    const queryEmbedding = await withTimeout(
      () => embed(query),
      EMBED_TIMEOUT_MS,
      "임베딩 생성 시간 초과"
    );
    return await withTimeout(
      () => vectorSearch(queryEmbedding, topK, minScore),
      SEARCH_TIMEOUT_MS,
      "벡터 검색 시간 초과"
    );
  } catch (error) {
    console.warn("[searchVector] Failed, returning empty:", error);
    return [];
  }
}

/**
 * 키워드 검색만 수행합니다.
 */
export function searchByKeyword(
  query: string,
  limit: number = 10
): FtsSearchResult[] {
  return searchKeyword(query, limit);
}

/**
 * 텍스트와 소스로 고유 키를 생성합니다.
 */
function makeKey(text: string, source: string): string {
  // 간단한 해시: 처음 100자 + 소스
  return `${source}:${text.slice(0, 100)}`;
}
