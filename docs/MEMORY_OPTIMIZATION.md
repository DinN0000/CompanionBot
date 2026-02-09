# 메모리 검색 최적화 가이드

## 개요

CompanionBot의 메모리 검색 성능을 개선하기 위한 최적화 방안입니다.

## 현재 구현의 병목점

### 1. 벡터 검색 (vectorStore.ts)
| 문제 | 영향 |
|------|------|
| 전체 청크 O(n) 선형 스캔 | 청크 수 증가 시 검색 속도 저하 |
| JSON 파일 기반 임베딩 캐시 | 파일 I/O 오버헤드, 큰 파일 파싱 지연 |
| 쿼리마다 임베딩 재생성 | 동일 쿼리 반복 시 불필요한 연산 |

### 2. FTS5 검색 (ftsIndex.ts)
| 문제 | 영향 |
|------|------|
| unicode61 tokenizer만 사용 | 한국어 형태소 분석 없음, 부분 매칭 불가 |
| 시간 필터링 없음 | 오래된 데이터까지 검색 |
| 쿼리 캐싱 없음 | 반복 쿼리 비효율 |

### 3. 하이브리드 검색 (hybridSearch.ts)
| 문제 | 영향 |
|------|------|
| 쿼리 임베딩 캐싱 없음 | 매 검색마다 임베딩 생성 |
| 고정 가중치만 지원 | 쿼리 특성에 따른 최적화 불가 |

## 최적화 구현

### 1. vectorStore.optimized.ts

```typescript
// 주요 개선사항:

// 1. SQLite 기반 임베딩 저장 (JSON 대신)
// - Binary BLOB으로 저장하여 직렬화/역직렬화 최적화
// - WAL 모드로 동시성 향상

// 2. 쿼리 결과 LRU 캐시
const queryCache = new Map<string, { results: SearchResult[]; timestamp: number }>();
const QUERY_CACHE_MAX = 100;
const QUERY_CACHE_TTL_MS = 60 * 1000;

// 3. 시간 기반 필터링
export interface SearchOptions {
  maxAgeDays?: number;  // 최근 N일만 검색
  sources?: string[];   // 특정 소스만 검색
}

// 4. 증분 인덱싱
// - 파일 해시로 변경 감지
// - 새로운 청크만 DB에 추가
```

### 2. ftsIndex.optimized.ts

```typescript
// 1. trigram tokenizer 추가 (한국어 부분 매칭)
CREATE VIRTUAL TABLE memory_fts_trigram USING fts5(
  id, source, text,
  tokenize='trigram'
);

// 2. 시간 필터링용 메타데이터 테이블
CREATE TABLE fts_metadata (
  id TEXT PRIMARY KEY,
  source TEXT,
  timestamp INTEGER
);

// 3. 하이브리드 키워드 검색
export function searchHybridKeyword(query, limit) {
  // unicode61 + trigram 결과 병합
}
```

### 3. hybridSearch.optimized.ts

```typescript
// 1. 쿼리 임베딩 캐싱
const queryEmbeddingCache = new Map<string, {
  embedding: number[];
  timestamp: number;
}>();

// 2. RRF (Reciprocal Rank Fusion) 지원
// - 순위 기반 점수 결합
// - 점수 스케일에 무관한 공정한 병합

// 3. 동적 가중치
export interface HybridSearchOptions {
  vectorWeight?: number;   // 기본 0.7
  keywordWeight?: number;  // 기본 0.3
  useRRF?: boolean;        // RRF 사용 여부
}
```

## 적용 방법

### 방법 1: 점진적 적용

```bash
# 1. 기존 파일 백업
cd ~/Projects/CompanionBot-temp/src/memory
cp vectorStore.ts vectorStore.original.ts
cp ftsIndex.ts ftsIndex.original.ts
cp hybridSearch.ts hybridSearch.original.ts

# 2. 최적화 버전으로 교체
cp vectorStore.optimized.ts vectorStore.ts
cp ftsIndex.optimized.ts ftsIndex.ts
cp hybridSearch.optimized.ts hybridSearch.ts

# 3. 테스트
npm run build
npm test
```

### 방법 2: 새 모듈로 추가

```typescript
// index.ts에서 선택적 import
import { hybridSearch as hybridSearchOptimized } from "./hybridSearch.optimized.js";

// 설정으로 선택
const useOptimized = process.env.USE_OPTIMIZED_MEMORY === "true";
export const hybridSearch = useOptimized ? hybridSearchOptimized : hybridSearchOriginal;
```

## 벤치마크 실행

```bash
# 현재 구현 벤치마크
npx tsx src/memory/benchmark.ts
```

예상 결과:
```
Vector Search:
  Before: ~150ms
  After:  ~50ms (쿼리 캐시 히트 시 <5ms)

FTS Search:
  Before: ~30ms
  After:  ~15ms (캐시 히트 시 <2ms)

Hybrid Search:
  Before: ~200ms
  After:  ~70ms (캐시 히트 시 <10ms)
```

## 추가 최적화 옵션

### 1. 대규모 데이터 (1000+ 청크)

벡터 인덱스 라이브러리 사용:
```bash
npm install hnswlib-node  # HNSW 알고리즘
# 또는
npm install faiss-node    # Facebook AI Similarity Search
```

### 2. 한국어 특화

형태소 분석기 추가:
```bash
npm install koalanlp  # 한국어 NLP
```

```typescript
import { Tagger } from "koalanlp/proc";

async function tokenizeKorean(text: string): Promise<string[]> {
  const tagger = await Tagger.create("EUNJEON");
  const result = await tagger.tag(text);
  return result.flatMap(s => s.morphemes.map(m => m.surface));
}
```

### 3. 임베딩 모델 업그레이드

더 좋은 한국어 지원:
```typescript
// 현재: Xenova/all-MiniLM-L6-v2 (영어 특화)
// 추천: sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2

pipeline("feature-extraction", "Xenova/paraphrase-multilingual-MiniLM-L12-v2");
```

## 마이그레이션 주의사항

1. **DB 파일 충돌**: 최적화 버전은 새 DB 파일 사용
   - 기존: `.embedding-cache.json`, `.fts-index.db`
   - 최적화: `.vector-store.db`, `.fts-index-v2.db`

2. **첫 실행 시간**: 새 DB 구축으로 초기 로딩 느림 (1회성)

3. **롤백**: 기존 파일로 복원하면 원래대로 동작

## 요약

| 영역 | 개선 내용 | 예상 효과 |
|------|----------|----------|
| 벡터 저장소 | SQLite + 쿼리 캐시 | 3x 속도 향상 |
| FTS | trigram + 시간 필터 | 2x 속도 + 한국어 매칭 |
| 하이브리드 | 임베딩 캐시 + RRF | 3x 속도 향상 |
| 인덱싱 | 증분 인덱싱 | 재시작 시간 단축 |
