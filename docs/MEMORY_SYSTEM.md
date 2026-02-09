# CompanionBot 메모리 시스템 설계

## 개요

CompanionBot의 메모리 시스템은 **로컬 임베딩 기반 시맨틱 검색**을 사용한다. 외부 API 없이 완전히 로컬에서 동작하며, 비용이 들지 않는다.

## 아키텍처

```
┌─────────────────────────────────────────────────────────────┐
│                     사용자 메시지                            │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                   buildSystemPrompt()                        │
│  ┌─────────────────────────────────────────────────────┐    │
│  │  getRelevantMemories(history)                        │    │
│  │    1. 최근 3개 user 메시지에서 컨텍스트 추출         │    │
│  │    2. embed(context) → 쿼리 벡터 생성               │    │
│  │    3. search(queryVec, topK=3, minScore=0.4)        │    │
│  │    4. 관련 메모리 스니펫 반환                        │    │
│  └─────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                     시스템 프롬프트                          │
│  ┌─────────────────┐  ┌─────────────────┐                   │
│  │ 런타임 정보      │  │ 워크스페이스     │                   │
│  │ - 날짜/시간     │  │ - IDENTITY.md   │                   │
│  │ - 채널 정보     │  │ - SOUL.md       │                   │
│  └─────────────────┘  │ - USER.md       │                   │
│                       │ - AGENTS.md     │                   │
│  ┌─────────────────┐  └─────────────────┘                   │
│  │ 관련 기억 ⭐    │                                        │
│  │ (벡터 검색 결과) │                                        │
│  └─────────────────┘                                        │
└─────────────────────────────────────────────────────────────┘
```

## 모듈 구조

```
src/memory/
├── index.ts          # 모듈 export
├── embeddings.ts     # 임베딩 생성 (로컬)
├── vectorStore.ts    # 벡터 저장/검색
└── indexer.ts        # 메모리 파일 인덱싱
```

## 핵심 컴포넌트

### 1. embeddings.ts - 로컬 임베딩

```typescript
import { pipeline } from "@xenova/transformers";

// 모델: Xenova/multilingual-e5-small (~100MB)
// - 다국어 지원 (한글 OK)
// - 384차원 벡터
// - 로컬 실행 (API 비용 없음)

export async function embed(text: string): Promise<number[]>
export async function embedBatch(texts: string[]): Promise<number[][]>
export function cosineSimilarity(a: number[], b: number[]): number
```

**특징:**
- 첫 실행 시 모델 자동 다운로드 (~100MB)
- 캐시 경로: `./.cache/transformers`
- 싱글톤 패턴으로 중복 로드 방지

### 2. vectorStore.ts - 벡터 저장소

```typescript
interface MemoryChunk {
  id: string;           // 고유 ID (source:index)
  text: string;         // 원본 텍스트
  embedding: number[];  // 384차원 벡터
  source: string;       // 출처 파일명
  timestamp: number;    // 인덱싱 시간
}

// 인메모리 캐시 + 5분 TTL
export async function search(
  queryEmbedding: number[],
  topK: number = 5,
  minScore: number = 0.3
): Promise<SearchResult[]>
```

**특징:**
- 인메모리 캐시로 빠른 검색
- 5분 TTL로 파일 변경 반영
- 코사인 유사도 기반 랭킹

### 3. indexer.ts - 메모리 인덱싱

```typescript
// 청크 분할 전략
function chunkText(text: string, maxChunkSize: number = 500): string[]
// - ## 헤더 기준 분할
// - 500자 제한
// - 20자 미만 청크 제외

// 인덱싱 함수
export async function indexMainMemory(): Promise<number>      // MEMORY.md
export async function indexDailyMemories(days: number = 30)   // memory/*.md
export async function reindexAll(): Promise<IndexResult>      // 전체 리인덱싱
```

**인덱싱 대상:**
- `MEMORY.md` - 장기 기억
- `memory/YYYY-MM-DD.md` - 최근 30일 일일 기억

## 데이터 흐름

### 1. 인덱싱 (봇 시작 시)

```
MEMORY.md ──────┐
                │
memory/*.md ────┼──▶ chunkText() ──▶ embedBatch() ──▶ 인메모리 캐시
(최근 30일)     │         │                │
                │     청크 분할        벡터 생성
                │    (500자 단위)    (384차원)
```

### 2. 검색 (메시지 처리 시)

```
최근 3개 user 메시지
        │
        ▼
  extractSearchContext()  ──▶  "프로젝트 진행 상황 어때?"
        │
        ▼
     embed(context)       ──▶  [0.12, -0.34, 0.56, ...]
        │
        ▼
  search(queryVec, 3, 0.4)
        │
        ▼
  ┌─────────────────────────────────────────┐
  │ [1] (MEMORY.md, score: 0.72)            │
  │ "프로젝트 A: 2월 중 완료 예정..."        │
  │                                         │
  │ [2] (2026-02-08.md, score: 0.65)        │
  │ "오늘 프로젝트 회의함. 다음 주..."       │
  └─────────────────────────────────────────┘
```

### 3. 프롬프트 주입

```typescript
// src/telegram/utils/prompt.ts

async function getRelevantMemories(history: Message[]): Promise<string> {
  const context = extractSearchContext(history);  // 최근 대화에서 쿼리 생성
  const queryEmbedding = await embed(context);
  const results = await search(queryEmbedding, 3, 0.4);
  
  return results.map(r => 
    `- (${r.source}): ${r.text.slice(0, 200)}...`
  ).join('\n');
}

// 시스템 프롬프트에 자동 추가
parts.push('\n\n## 관련 기억\n' + relevantMemories);
```

## 도구 (Tools)

### memory_search

사용자가 명시적으로 기억 검색 요청 시:

```typescript
{
  name: "memory_search",
  description: "Search through long-term memories using semantic similarity",
  input_schema: {
    query: string,      // 검색 쿼리
    limit?: number,     // 최대 결과 수 (기본: 5)
    minScore?: number   // 최소 유사도 (기본: 0.3)
  }
}
```

### memory_reindex

메모리 파일 변경 후 수동 리인덱싱:

```typescript
{
  name: "memory_reindex",
  description: "Reindex all memory files",
  input_schema: {}
}
```

## 파일 구조

```
~/.companionbot/
├── MEMORY.md              # 장기 기억 (사용자/AI 작성)
│   └── 중요한 정보, 결정사항, 프로젝트 노트 등
│
├── memory/                # 일일 기억 디렉토리
│   ├── 2026-02-09.md     # 오늘
│   ├── 2026-02-08.md     # 어제
│   └── ...               # 최근 30일
│
└── .cache/
    └── transformers/     # 임베딩 모델 캐시 (~100MB)
```

## 성능 특성

| 항목 | 값 | 비고 |
|------|-----|------|
| 임베딩 모델 크기 | ~100MB | 첫 실행 시 다운로드 |
| 벡터 차원 | 384 | multilingual-e5-small |
| 검색 시간 | <50ms | 1000개 청크 기준 |
| 캐시 TTL | 5분 | 파일 변경 반영 |
| 청크 크기 | 500자 | 헤더 기준 분할 |
| 인덱싱 범위 | 30일 | 일일 메모리 |

## OpenClaw와의 차이점

| 항목 | CompanionBot | OpenClaw |
|------|--------------|----------|
| **임베딩** | 로컬 (무료) | API 기반 (유료) |
| **검색** | 시맨틱만 | 하이브리드 (시맨틱+키워드) |
| **저장소** | 인메모리 캐시 | SQLite + FTS5 |
| **품질** | 양호 (384차원) | 우수 (1536차원) |
| **비용** | 0원 | API 비용 발생 |
| **오프라인** | ✅ 가능 | ❌ 불가 |

## 설계 결정 이유

### 1. 로컬 임베딩 선택

- **비용**: 개인용 봇에서 API 비용은 부담
- **프라이버시**: 개인 기억이 외부 서버로 전송되지 않음
- **오프라인**: 네트워크 없이도 동작

### 2. 인메모리 캐시 선택

- **단순성**: SQLite 설정/관리 불필요
- **충분한 성능**: 개인용 규모에서 충분
- **재시작 시 자동 리인덱싱**: 항상 최신 상태 유지

### 3. 자동 컨텍스트 주입

- **사용자 경험**: 명시적 도구 호출 없이도 관련 기억 활용
- **자연스러운 대화**: "저번에 말한 거" 자동으로 찾음

## 향후 개선 가능성

1. **하이브리드 검색**: BM25 키워드 검색 추가
2. **영구 저장**: SQLite로 마이그레이션 (대용량 대응)
3. **자동 캡처**: 대화에서 중요 정보 자동 추출
4. **청크 전략 개선**: 시맨틱 청킹 (문맥 보존)

## 관련 파일

- `src/memory/embeddings.ts` - 임베딩 생성
- `src/memory/vectorStore.ts` - 벡터 저장/검색
- `src/memory/indexer.ts` - 메모리 인덱싱
- `src/telegram/utils/prompt.ts` - 프롬프트 주입
- `src/tools/index.ts` - memory_search, memory_reindex 도구
