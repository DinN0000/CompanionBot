/**
 * 최적화된 하이브리드 검색 모듈 v2
 * 
 * 개선사항:
 * 1. 쿼리 임베딩 캐싱
 * 2. 시간 기반 필터링 통합
 * 3. 조기 종료 최적화
 * 4. 가중치 동적 조정
 * 5. RRF (Reciprocal Rank Fusion) 지원
 */

import { embed } from "./embeddings.js";
import { 
  search as vectorSearch, 
  type SearchResult,
  type SearchOptions as VectorSearchOptions 
} from "./vectorStore.optimized.js";
import { 
  searchKeyword, 
  searchHybridKeyword,
  type FtsSearchResult,
  type FtsSearchOptions
} from "./ftsIndex.optimized.js";

// ============================================
// 타입 정의
// ============================================

export interface HybridSearchResult {
  text: string;
  source: string;
  score: number;
  vectorScore?: number;
  keywordScore?: number;
  rrfScore?: number;
}

export interface HybridSearchOptions {
  topK?: number;
  vectorWeight?: number;
  keywordWeight?: number;
  maxAgeDays?: number;
  sources?: string[];
  useRRF?: boolean;        // Reciprocal Rank Fusion 사용
  useTrigram?: boolean;    // trigram 검색 포함
  minVectorScore?: number;
}

// ============================================
// 쿼리 임베딩 캐시
// ============================================

const queryEmbeddingCache = new Map<string, { embedding: number[]; timestamp: number }>();
const EMBEDDING_CACHE_MAX = 50;
const EMBEDDING_CACHE_TTL_MS = 5 * 60 * 1000; // 5분

/**
 * 캐시된 쿼리 임베딩 가져오기
 */
async function getCachedQueryEmbedding(query: string): Promise<number[]> {
  const cached = queryEmbeddingCache.get(query);
  if (cached && Date.now() - cached.timestamp < EMBEDDING_CACHE_TTL_MS) {
    return cached.embedding;
  }
  
  const embedding = await embed(query);
  
  // 캐시 정리
  if (queryEmbeddingCache.size >= EMBEDDING_CACHE_MAX) {
    const entries = Array.from(queryEmbeddingCache.entries());
    entries.sort((a, b) => a[1].timestamp - b[1].timestamp);
    for (let i = 0; i < Math.floor(EMBEDDING_CACHE_MAX / 2); i++) {
      queryEmbeddingCache.delete(entries[i][0]);
    }
  }
  
  queryEmbeddingCache.set(query, { embedding, timestamp: Date.now() });
  return embedding;
}

// ============================================
// 점수 정규화
// ============================================

/**
 * BM25 점수 정규화 (낮을수록 좋음 → 높을수록 좋음)
 */
function normalizeBm25Score(score: number, minScore: number, maxScore: number): number {
  if (maxScore === minScore) return 1;
  const normalized = (maxScore - score) / (maxScore - minScore);
  return Math.max(0, Math.min(1, normalized));
}

/**
 * RRF (Reciprocal Rank Fusion) 점수 계산
 * 순위 기반 점수 결합 - 점수 스케일에 무관
 */
function calculateRRFScore(vectorRank: number | null, keywordRank: number | null, k: number = 60): number {
  let score = 0;
  if (vectorRank !== null) {
    score += 1 / (k + vectorRank);
  }
  if (keywordRank !== null) {
    score += 1 / (k + keywordRank);
  }
  return score;
}

// ============================================
// 검색 함수
// ============================================

/**
 * 결과 키 생성
 */
function makeKey(text: string, source: string): string {
  return `${source}:${text.slice(0, 100)}`;
}

/**
 * 하이브리드 검색 (벡터 + 키워드)
 */
export async function hybridSearch(
  query: string,
  options: HybridSearchOptions = {}
): Promise<HybridSearchResult[]> {
  const {
    topK = 5,
    vectorWeight = 0.7,
    keywordWeight = 0.3,
    maxAgeDays,
    sources,
    useRRF = false,
    useTrigram = true,
    minVectorScore = 0.2,
  } = options;

  // 병렬 실행: 쿼리 임베딩 + 키워드 검색
  const fetchK = topK * 2; // 병합을 위해 더 많이 가져옴
  
  const [queryEmbedding, keywordResults] = await Promise.all([
    getCachedQueryEmbedding(query),
    Promise.resolve(
      useTrigram 
        ? searchHybridKeyword(query, fetchK)
        : searchKeyword(query, fetchK, { maxAgeDays, sources })
    ),
  ]);

  // 벡터 검색
  const vectorResults = await vectorSearch(
    queryEmbedding,
    fetchK,
    minVectorScore,
    { maxAgeDays, sources }
  );

  // 결과 없으면 빈 배열
  if (vectorResults.length === 0 && keywordResults.length === 0) {
    return [];
  }

  // RRF vs 가중치 기반 점수 결합
  if (useRRF) {
    return combineWithRRF(vectorResults, keywordResults, topK);
  } else {
    return combineWithWeights(vectorResults, keywordResults, vectorWeight, keywordWeight, topK);
  }
}

/**
 * 가중치 기반 점수 결합
 */
function combineWithWeights(
  vectorResults: SearchResult[],
  keywordResults: FtsSearchResult[],
  vectorWeight: number,
  keywordWeight: number,
  topK: number
): HybridSearchResult[] {
  const scoreMap = new Map<string, HybridSearchResult>();

  // 벡터 결과 처리
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
        existing.score += normalizedScore * keywordWeight;
        existing.keywordScore = normalizedScore;
      } else {
        scoreMap.set(key, {
          text: result.text,
          source: result.source,
          score: normalizedScore * keywordWeight,
          keywordScore: normalizedScore,
        });
      }
    }
  }

  return Array.from(scoreMap.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

/**
 * RRF 기반 결합 (순위 기반)
 */
function combineWithRRF(
  vectorResults: SearchResult[],
  keywordResults: FtsSearchResult[],
  topK: number
): HybridSearchResult[] {
  // 순위 맵 생성
  const vectorRankMap = new Map<string, number>();
  const keywordRankMap = new Map<string, number>();
  
  vectorResults.forEach((r, i) => {
    vectorRankMap.set(makeKey(r.text, r.source), i + 1);
  });
  
  keywordResults.forEach((r, i) => {
    keywordRankMap.set(makeKey(r.text, r.source), i + 1);
  });
  
  // 모든 고유 결과 수집
  const allResults = new Map<string, { text: string; source: string; vectorScore?: number; keywordScore?: number }>();
  
  for (const r of vectorResults) {
    const key = makeKey(r.text, r.source);
    allResults.set(key, { text: r.text, source: r.source, vectorScore: r.score });
  }
  
  for (const r of keywordResults) {
    const key = makeKey(r.text, r.source);
    const existing = allResults.get(key);
    if (existing) {
      existing.keywordScore = r.score;
    } else {
      allResults.set(key, { text: r.text, source: r.source, keywordScore: r.score });
    }
  }
  
  // RRF 점수 계산
  const results: HybridSearchResult[] = [];
  
  for (const [key, data] of allResults) {
    const vectorRank = vectorRankMap.get(key) ?? null;
    const keywordRank = keywordRankMap.get(key) ?? null;
    const rrfScore = calculateRRFScore(vectorRank, keywordRank);
    
    results.push({
      text: data.text,
      source: data.source,
      score: rrfScore,
      vectorScore: data.vectorScore,
      keywordScore: data.keywordScore,
      rrfScore,
    });
  }
  
  return results
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

/**
 * 벡터 검색만 (하위 호환)
 */
export async function searchVector(
  query: string,
  topK: number = 5,
  minScore: number = 0.3,
  options?: { maxAgeDays?: number; sources?: string[] }
): Promise<SearchResult[]> {
  const queryEmbedding = await getCachedQueryEmbedding(query);
  return vectorSearch(queryEmbedding, topK, minScore, options);
}

/**
 * 키워드 검색만 (하위 호환)
 */
export function searchByKeyword(
  query: string,
  limit: number = 10,
  options?: FtsSearchOptions
): FtsSearchResult[] {
  return searchKeyword(query, limit, options);
}

/**
 * 캐시 무효화
 */
export function invalidateQueryCache(): void {
  queryEmbeddingCache.clear();
}
