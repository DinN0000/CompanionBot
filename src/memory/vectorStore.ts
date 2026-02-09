/**
 * 간단한 벡터 저장소 모듈
 * 메모리 파일들을 로드하고 유사도 기반으로 검색합니다.
 * 임베딩은 파일에 캐시되어 재시작 후에도 유지됩니다.
 */

import * as fs from "fs/promises";
import * as path from "path";
import { getMemoryDirPath, getWorkspaceFilePath } from "../workspace/paths.js";
import { embed, embedBatch, cosineSimilarity } from "./embeddings.js";
import { MEMORY } from "../config/constants.js";

export interface MemoryChunk {
  text: string;
  source: string;
  embedding?: number[];
  hash?: string; // 텍스트 변경 감지용
}

export interface SearchResult {
  text: string;
  source: string;
  score: number;
}

// 캐시된 청크들 (임베딩 포함)
let cachedChunks: MemoryChunk[] = [];
let cacheTimestamp = 0;

// 임베딩 영속 캐시 (hash → embedding)
let embeddingCache: Map<string, number[]> = new Map();
let embeddingCacheLoaded = false;

// 로딩 중복 방지용 Promise
let loadingPromise: Promise<MemoryChunk[]> | null = null;

/**
 * 간단한 해시 함수 (텍스트 변경 감지용)
 */
function simpleHash(text: string): string {
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    const char = text.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // 32bit 정수로 변환
  }
  return hash.toString(16);
}

/**
 * 임베딩 캐시 파일 경로
 */
function getEmbeddingCachePath(): string {
  return path.join(getMemoryDirPath(), ".embedding-cache.json");
}

/**
 * 임베딩 캐시를 파일에서 로드합니다.
 */
async function loadEmbeddingCache(): Promise<void> {
  if (embeddingCacheLoaded) return;
  
  try {
    const cachePath = getEmbeddingCachePath();
    const data = await fs.readFile(cachePath, "utf-8");
    const parsed = JSON.parse(data) as Record<string, number[]>;
    embeddingCache = new Map(Object.entries(parsed));
    console.log(`[VectorStore] Loaded ${embeddingCache.size} cached embeddings`);
  } catch {
    // 파일 없거나 파싱 실패 - 새로 시작
    embeddingCache = new Map();
  }
  embeddingCacheLoaded = true;
}

/**
 * 임베딩 캐시를 파일에 저장합니다.
 */
async function saveEmbeddingCache(): Promise<void> {
  try {
    const cachePath = getEmbeddingCachePath();
    const obj = Object.fromEntries(embeddingCache);
    await fs.writeFile(cachePath, JSON.stringify(obj), "utf-8");
  } catch (error) {
    console.warn("[VectorStore] Failed to save embedding cache:", error);
  }
}

/**
 * 텍스트를 적절한 크기의 청크로 분할합니다.
 */
function splitIntoChunks(text: string, source: string): MemoryChunk[] {
  const chunks: MemoryChunk[] = [];
  
  // ## 헤더로 분할 (메모리 파일 형식)
  const sections = text.split(/(?=^## )/m);
  
  for (const section of sections) {
    const trimmed = section.trim();
    if (!trimmed || trimmed.length < MEMORY.MIN_CHUNK_LENGTH) continue;
    
    // 청크가 너무 길면 추가로 분할
    if (trimmed.length > MEMORY.MAX_CHUNK_LENGTH) {
      const lines = trimmed.split("\n");
      let currentChunk = "";
      
      for (const line of lines) {
        if (currentChunk.length + line.length > MEMORY.MAX_CHUNK_LENGTH) {
          if (currentChunk.trim()) {
            chunks.push({ 
              text: currentChunk.trim(), 
              source,
              hash: simpleHash(currentChunk.trim())
            });
          }
          currentChunk = line;
        } else {
          currentChunk += "\n" + line;
        }
      }
      
      if (currentChunk.trim()) {
        chunks.push({ 
          text: currentChunk.trim(), 
          source,
          hash: simpleHash(currentChunk.trim())
        });
      }
    } else {
      chunks.push({ 
        text: trimmed, 
        source,
        hash: simpleHash(trimmed)
      });
    }
  }
  
  return chunks;
}

/**
 * 내부 로드 로직 - 실제 파일 로드 수행
 */
async function doLoadAllMemoryChunks(): Promise<MemoryChunk[]> {
  // 임베딩 캐시 로드
  await loadEmbeddingCache();
  
  const chunks: MemoryChunk[] = [];

  // 1. 일별 메모리 파일
  const memoryDir = getMemoryDirPath();
  try {
    const files = await fs.readdir(memoryDir);
    const mdFiles = files.filter(f => f.endsWith(".md") && !f.startsWith(".")).sort().reverse().slice(0, MEMORY.RECENT_DAYS);
    
    for (const file of mdFiles) {
      try {
        const content = await fs.readFile(path.join(memoryDir, file), "utf-8");
        const fileChunks = splitIntoChunks(content, file.replace(".md", ""));
        chunks.push(...fileChunks);
      } catch {
        // 파일 읽기 실패 무시
      }
    }
  } catch {
    // 디렉토리 없음 무시
  }

  // 2. MEMORY.md (장기 기억)
  try {
    const memoryMdPath = getWorkspaceFilePath("MEMORY.md");
    const content = await fs.readFile(memoryMdPath, "utf-8");
    const memoryChunks = splitIntoChunks(content, "MEMORY");
    chunks.push(...memoryChunks);
  } catch {
    // 파일 없음 무시
  }

  // 3. 캐시된 임베딩 복원
  for (const chunk of chunks) {
    if (chunk.hash) {
      const cachedEmbedding = embeddingCache.get(chunk.hash);
      if (cachedEmbedding) {
        chunk.embedding = cachedEmbedding;
      }
    }
  }

  return chunks;
}

/**
 * 모든 메모리 파일을 로드하고 청크로 분할합니다.
 * 동시 요청 시 중복 로드를 방지합니다.
 */
export async function loadAllMemoryChunks(): Promise<MemoryChunk[]> {
  const now = Date.now();
  
  // 캐시가 유효하면 반환
  if (cachedChunks.length > 0 && now - cacheTimestamp < MEMORY.CACHE_TTL_MS) {
    return cachedChunks;
  }

  // 이미 로딩 중이면 해당 Promise 반환 (중복 로드 방지)
  if (loadingPromise) {
    return loadingPromise;
  }

  // 새로 로드
  loadingPromise = doLoadAllMemoryChunks();
  try {
    const chunks = await loadingPromise;
    // 캐시 업데이트 (임베딩은 아직 없음)
    // 빈 결과도 캐시하되 TTL을 짧게 (1분)
    cachedChunks = chunks;
    cacheTimestamp = chunks.length > 0 ? Date.now() : Date.now() - MEMORY.CACHE_TTL_MS + 60000;
    return chunks;
  } catch (error) {
    // 로드 실패 시 캐시하지 않음
    console.error("[VectorStore] Failed to load memory chunks:", error);
    return [];
  } finally {
    loadingPromise = null;
  }
}

/**
 * 쿼리 임베딩으로 관련 메모리를 검색합니다.
 * @param queryEmbedding 검색 쿼리의 임베딩 벡터
 * @param topK 반환할 최대 결과 수
 * @param minScore 최소 유사도 점수 (0-1)
 */
export async function search(
  queryEmbedding: number[],
  topK: number = MEMORY.SEARCH_TOP_K,
  minScore: number = MEMORY.MIN_SIMILARITY
): Promise<SearchResult[]> {
  const chunks = await loadAllMemoryChunks();
  
  if (chunks.length === 0) {
    return [];
  }

  // 임베딩이 없는 청크들을 배치로 처리
  const chunksNeedingEmbedding = chunks.filter(c => !c.embedding);
  
  if (chunksNeedingEmbedding.length > 0) {
    console.log(`[VectorStore] Generating embeddings for ${chunksNeedingEmbedding.length} chunks`);
    
    try {
      const texts = chunksNeedingEmbedding.map(c => c.text);
      const embeddings = await embedBatch(texts);
      
      // 임베딩 할당 및 캐시 저장
      for (let i = 0; i < chunksNeedingEmbedding.length; i++) {
        const chunk = chunksNeedingEmbedding[i];
        chunk.embedding = embeddings[i];
        if (chunk.hash) {
          embeddingCache.set(chunk.hash, embeddings[i]);
        }
      }
      
      // 캐시 파일 저장 (비동기, 실패해도 무시)
      saveEmbeddingCache().catch(() => {});
    } catch {
      // 배치 실패 시 개별 처리 폴백
      for (const chunk of chunksNeedingEmbedding) {
        try {
          chunk.embedding = await embed(chunk.text);
          if (chunk.hash) {
            embeddingCache.set(chunk.hash, chunk.embedding);
          }
        } catch {
          // 개별 실패 무시
        }
      }
      saveEmbeddingCache().catch(() => {});
    }
  }

  // 유사도 계산 및 필터링
  const results: SearchResult[] = [];
  
  for (const chunk of chunks) {
    if (!chunk.embedding) continue;
    
    const score = cosineSimilarity(queryEmbedding, chunk.embedding);
    
    if (score >= minScore) {
      results.push({
        text: chunk.text,
        source: chunk.source,
        score,
      });
    }
  }

  // 유사도 점수로 정렬하고 상위 K개 반환
  return results
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

/**
 * 캐시를 무효화합니다.
 * 임베딩 캐시는 유지 (텍스트 해시 기반이므로)
 */
export function invalidateCache(): void {
  cachedChunks = [];
  cacheTimestamp = 0;
  loadingPromise = null;
}

/**
 * 임베딩 캐시까지 완전 초기화합니다.
 */
export async function clearAllCaches(): Promise<void> {
  invalidateCache();
  embeddingCache.clear();
  embeddingCacheLoaded = false;
  
  try {
    await fs.unlink(getEmbeddingCachePath());
  } catch {
    // 파일 없으면 무시
  }
}

// 영속적 저장소용 인터페이스
export interface VectorEntry {
  id: string;
  text: string;
  embedding: number[];
  source: string;
  timestamp: number;
}

// 인메모리 저장소 (간단한 구현)
let vectorStore: VectorEntry[] = [];

/**
 * 엔트리들을 저장소에 추가/업데이트합니다.
 */
export async function upsertEntries(entries: VectorEntry[]): Promise<void> {
  for (const entry of entries) {
    const existingIndex = vectorStore.findIndex(e => e.id === entry.id);
    if (existingIndex >= 0) {
      vectorStore[existingIndex] = entry;
    } else {
      vectorStore.push(entry);
    }
  }
  
  // 캐시 무효화
  invalidateCache();
}

/**
 * 특정 소스의 모든 엔트리를 삭제합니다.
 */
export async function deleteBySource(source: string): Promise<number> {
  const before = vectorStore.length;
  vectorStore = vectorStore.filter(e => e.source !== source);
  const deleted = before - vectorStore.length;
  
  if (deleted > 0) {
    invalidateCache();
  }
  
  return deleted;
}

/**
 * 저장소의 모든 엔트리를 반환합니다.
 */
export function getAllEntries(): VectorEntry[] {
  return [...vectorStore];
}
