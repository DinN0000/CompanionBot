/**
 * 최적화된 벡터 저장소 모듈 v2
 * 
 * 개선사항:
 * 1. SQLite 기반 임베딩 저장 (JSON 대신)
 * 2. 쿼리 결과 LRU 캐시
 * 3. 시간 기반 필터링
 * 4. 배치 코사인 계산 최적화
 * 5. 증분 인덱싱 지원
 */

import Database from "better-sqlite3";
import * as fs from "fs/promises";
import * as path from "path";
import { getMemoryDirPath, getWorkspaceFilePath } from "../workspace/paths.js";
import { embed, embedBatch, cosineSimilarity } from "./embeddings.js";
import { MEMORY } from "../config/constants.js";

// ============================================
// 타입 정의
// ============================================

export interface MemoryChunk {
  id: string;
  text: string;
  source: string;
  embedding?: number[];
  hash: string;
  timestamp: number; // Unix timestamp (ms)
}

export interface SearchResult {
  text: string;
  source: string;
  score: number;
}

export interface SearchOptions {
  topK?: number;
  minScore?: number;
  maxAgeDays?: number;  // 검색 범위 제한
  sources?: string[];   // 특정 소스만 검색
}

// ============================================
// 싱글톤 DB 및 캐시
// ============================================

let db: Database.Database | null = null;

// LRU 쿼리 캐시 (최대 100개)
const queryCache = new Map<string, { results: SearchResult[]; timestamp: number }>();
const QUERY_CACHE_MAX = 100;
const QUERY_CACHE_TTL_MS = 60 * 1000; // 1분

// 청크 메모리 캐시 (빠른 검색용)
let chunkCache: MemoryChunk[] = [];
let chunkCacheTimestamp = 0;

// 로딩 중복 방지
let loadingPromise: Promise<MemoryChunk[]> | null = null;

// ============================================
// 데이터베이스 관리
// ============================================

function getDbPath(): string {
  return path.join(getMemoryDirPath(), ".vector-store.db");
}

function getDb(): Database.Database {
  if (db) return db;

  const dbPath = getDbPath();
  db = new Database(dbPath);
  
  // WAL 모드 (동시성 향상)
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  
  // 테이블 생성
  db.exec(`
    CREATE TABLE IF NOT EXISTS chunks (
      id TEXT PRIMARY KEY,
      text TEXT NOT NULL,
      source TEXT NOT NULL,
      hash TEXT NOT NULL,
      embedding BLOB,
      timestamp INTEGER NOT NULL,
      created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000)
    );
    
    CREATE INDEX IF NOT EXISTS idx_chunks_source ON chunks(source);
    CREATE INDEX IF NOT EXISTS idx_chunks_timestamp ON chunks(timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_chunks_hash ON chunks(hash);
  `);

  return db;
}

/**
 * 데이터베이스 연결 닫기
 */
export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

// ============================================
// 해시 유틸리티
// ============================================

function simpleHash(text: string): string {
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    const char = text.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return hash.toString(16);
}

// ============================================
// 임베딩 직렬화
// ============================================

function serializeEmbedding(embedding: number[]): Buffer {
  const buffer = Buffer.alloc(embedding.length * 4);
  for (let i = 0; i < embedding.length; i++) {
    buffer.writeFloatLE(embedding[i], i * 4);
  }
  return buffer;
}

function deserializeEmbedding(buffer: Buffer): number[] {
  const embedding: number[] = [];
  for (let i = 0; i < buffer.length; i += 4) {
    embedding.push(buffer.readFloatLE(i));
  }
  return embedding;
}

// ============================================
// 청크 관리
// ============================================

/**
 * 청크를 DB에 upsert
 */
export function upsertChunk(chunk: Omit<MemoryChunk, "id"> & { id?: string }): string {
  const database = getDb();
  const id = chunk.id || `${chunk.source}:${simpleHash(chunk.text)}`;
  
  const stmt = database.prepare(`
    INSERT OR REPLACE INTO chunks (id, text, source, hash, embedding, timestamp)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  
  const embeddingBlob = chunk.embedding ? serializeEmbedding(chunk.embedding) : null;
  stmt.run(id, chunk.text, chunk.source, chunk.hash, embeddingBlob, chunk.timestamp);
  
  // 캐시 무효화
  invalidateCache();
  
  return id;
}

/**
 * 여러 청크를 배치로 upsert (트랜잭션)
 */
export function upsertChunksBatch(chunks: Array<Omit<MemoryChunk, "id"> & { id?: string }>): number {
  if (chunks.length === 0) return 0;
  
  const database = getDb();
  const stmt = database.prepare(`
    INSERT OR REPLACE INTO chunks (id, text, source, hash, embedding, timestamp)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  
  const transaction = database.transaction(() => {
    for (const chunk of chunks) {
      const id = chunk.id || `${chunk.source}:${simpleHash(chunk.text)}`;
      const embeddingBlob = chunk.embedding ? serializeEmbedding(chunk.embedding) : null;
      stmt.run(id, chunk.text, chunk.source, chunk.hash, embeddingBlob, chunk.timestamp);
    }
  });
  
  transaction();
  invalidateCache();
  
  return chunks.length;
}

/**
 * 소스별 청크 삭제
 */
export function deleteBySource(source: string): number {
  const database = getDb();
  const stmt = database.prepare("DELETE FROM chunks WHERE source = ?");
  const result = stmt.run(source);
  
  if (result.changes > 0) {
    invalidateCache();
  }
  
  return result.changes;
}

// ============================================
// 청크 로딩
// ============================================

/**
 * 텍스트를 청크로 분할
 */
function splitIntoChunks(text: string, source: string, timestamp: number): MemoryChunk[] {
  const chunks: MemoryChunk[] = [];
  let chunkIndex = 0;
  
  const sections = text.split(/(?=^## )/m);
  
  for (const section of sections) {
    const trimmed = section.trim();
    if (!trimmed || trimmed.length < MEMORY.MIN_CHUNK_LENGTH) continue;
    
    if (trimmed.length > MEMORY.MAX_CHUNK_LENGTH) {
      const lines = trimmed.split("\n");
      let currentChunk = "";
      
      for (const line of lines) {
        if (currentChunk.length + line.length > MEMORY.MAX_CHUNK_LENGTH) {
          if (currentChunk.trim()) {
            const text = currentChunk.trim();
            chunks.push({
              id: `${source}:${chunkIndex++}`,
              text,
              source,
              hash: simpleHash(text),
              timestamp,
            });
          }
          currentChunk = line;
        } else {
          currentChunk += "\n" + line;
        }
      }
      
      if (currentChunk.trim()) {
        const text = currentChunk.trim();
        chunks.push({
          id: `${source}:${chunkIndex++}`,
          text,
          source,
          hash: simpleHash(text),
          timestamp,
        });
      }
    } else {
      chunks.push({
        id: `${source}:${chunkIndex++}`,
        text: trimmed,
        source,
        hash: simpleHash(trimmed),
        timestamp,
      });
    }
  }
  
  return chunks;
}

/**
 * 파일 시스템에서 메모리 파일 로드 및 인덱싱
 */
async function loadFromFilesystem(): Promise<MemoryChunk[]> {
  const database = getDb();
  const chunks: MemoryChunk[] = [];
  
  // 기존 해시 목록 조회 (변경 감지용)
  const existingHashes = new Set<string>();
  const hashStmt = database.prepare("SELECT hash FROM chunks");
  for (const row of hashStmt.iterate() as Iterable<{ hash: string }>) {
    existingHashes.add(row.hash);
  }
  
  const newChunks: MemoryChunk[] = [];
  
  // 1. 일별 메모리 파일
  const memoryDir = getMemoryDirPath();
  try {
    const files = await fs.readdir(memoryDir);
    const mdFiles = files
      .filter(f => f.endsWith(".md") && !f.startsWith("."))
      .sort()
      .reverse()
      .slice(0, MEMORY.RECENT_DAYS);
    
    for (const file of mdFiles) {
      try {
        const filePath = path.join(memoryDir, file);
        const stat = await fs.stat(filePath);
        const content = await fs.readFile(filePath, "utf-8");
        const source = file.replace(".md", "");
        const timestamp = stat.mtimeMs;
        
        const fileChunks = splitIntoChunks(content, source, timestamp);
        for (const chunk of fileChunks) {
          if (!existingHashes.has(chunk.hash)) {
            newChunks.push(chunk);
          }
          chunks.push(chunk);
        }
      } catch {
        // 파일 읽기 실패 무시
      }
    }
  } catch {
    // 디렉토리 없음 무시
  }
  
  // 2. MEMORY.md
  try {
    const memoryMdPath = getWorkspaceFilePath("MEMORY.md");
    const stat = await fs.stat(memoryMdPath);
    const content = await fs.readFile(memoryMdPath, "utf-8");
    const timestamp = stat.mtimeMs;
    
    const memoryChunks = splitIntoChunks(content, "MEMORY", timestamp);
    for (const chunk of memoryChunks) {
      if (!existingHashes.has(chunk.hash)) {
        newChunks.push(chunk);
      }
      chunks.push(chunk);
    }
  } catch {
    // 파일 없음 무시
  }
  
  // 새 청크가 있으면 DB에 저장
  if (newChunks.length > 0) {
    console.log(`[VectorStore] Found ${newChunks.length} new chunks to index`);
    upsertChunksBatch(newChunks);
  }
  
  return chunks;
}

/**
 * DB에서 청크 로드 (임베딩 포함)
 */
function loadFromDb(options?: { maxAgeDays?: number; sources?: string[] }): MemoryChunk[] {
  const database = getDb();
  
  let sql = "SELECT id, text, source, hash, embedding, timestamp FROM chunks WHERE 1=1";
  const params: (string | number)[] = [];
  
  // 시간 필터
  if (options?.maxAgeDays) {
    const cutoff = Date.now() - (options.maxAgeDays * 24 * 60 * 60 * 1000);
    sql += " AND timestamp >= ?";
    params.push(cutoff);
  }
  
  // 소스 필터
  if (options?.sources && options.sources.length > 0) {
    const placeholders = options.sources.map(() => "?").join(", ");
    sql += ` AND source IN (${placeholders})`;
    params.push(...options.sources);
  }
  
  sql += " ORDER BY timestamp DESC";
  
  const stmt = database.prepare(sql);
  const rows = stmt.all(...params) as Array<{
    id: string;
    text: string;
    source: string;
    hash: string;
    embedding: Buffer | null;
    timestamp: number;
  }>;
  
  return rows.map(row => ({
    id: row.id,
    text: row.text,
    source: row.source,
    hash: row.hash,
    embedding: row.embedding ? deserializeEmbedding(row.embedding) : undefined,
    timestamp: row.timestamp,
  }));
}

/**
 * 모든 메모리 청크 로드 (캐시 포함)
 */
export async function loadAllMemoryChunks(): Promise<MemoryChunk[]> {
  const now = Date.now();
  
  // 캐시 유효하면 반환
  if (chunkCache.length > 0 && now - chunkCacheTimestamp < MEMORY.CACHE_TTL_MS) {
    return chunkCache;
  }
  
  // 로딩 중이면 대기
  if (loadingPromise) {
    return loadingPromise;
  }
  
  loadingPromise = (async () => {
    // 파일시스템에서 새 청크 로드 (증분 인덱싱)
    await loadFromFilesystem();
    
    // DB에서 전체 로드
    const chunks = loadFromDb();
    
    chunkCache = chunks;
    chunkCacheTimestamp = chunks.length > 0 ? Date.now() : Date.now() - MEMORY.CACHE_TTL_MS + 60000;
    
    return chunks;
  })();
  
  try {
    return await loadingPromise;
  } finally {
    loadingPromise = null;
  }
}

// ============================================
// 벡터 검색
// ============================================

/**
 * 쿼리 캐시 키 생성
 */
function makeCacheKey(embedding: number[], options: SearchOptions): string {
  // 임베딩의 첫 10개 값으로 키 생성 (근사)
  const embKey = embedding.slice(0, 10).map(v => v.toFixed(4)).join(",");
  return `${embKey}:${options.topK}:${options.minScore}:${options.maxAgeDays}:${options.sources?.join(",")}`;
}

/**
 * LRU 캐시 정리
 */
function pruneQueryCache(): void {
  if (queryCache.size <= QUERY_CACHE_MAX) return;
  
  // 가장 오래된 항목 삭제
  const entries = Array.from(queryCache.entries());
  entries.sort((a, b) => a[1].timestamp - b[1].timestamp);
  
  const toDelete = entries.slice(0, Math.floor(QUERY_CACHE_MAX / 2));
  for (const [key] of toDelete) {
    queryCache.delete(key);
  }
}

/**
 * 쿼리 임베딩으로 벡터 검색
 */
export async function search(
  queryEmbedding: number[],
  topK: number = MEMORY.SEARCH_TOP_K,
  minScore: number = MEMORY.MIN_SIMILARITY,
  options?: Omit<SearchOptions, "topK" | "minScore">
): Promise<SearchResult[]> {
  const searchOptions: SearchOptions = { topK, minScore, ...options };
  
  // 캐시 확인
  const cacheKey = makeCacheKey(queryEmbedding, searchOptions);
  const cached = queryCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < QUERY_CACHE_TTL_MS) {
    return cached.results;
  }
  
  // DB에서 청크 로드 (필터 적용)
  let chunks = loadFromDb(options);
  
  if (chunks.length === 0) {
    // DB가 비어있으면 파일시스템에서 로드
    chunks = await loadAllMemoryChunks();
  }
  
  if (chunks.length === 0) {
    return [];
  }
  
  // 임베딩 없는 청크 처리
  const chunksNeedingEmbedding = chunks.filter(c => !c.embedding);
  
  if (chunksNeedingEmbedding.length > 0) {
    console.log(`[VectorStore] Generating embeddings for ${chunksNeedingEmbedding.length} chunks`);
    
    try {
      const texts = chunksNeedingEmbedding.map(c => c.text);
      const embeddings = await embedBatch(texts);
      
      // 임베딩 할당 및 DB 저장
      const database = getDb();
      const updateStmt = database.prepare("UPDATE chunks SET embedding = ? WHERE id = ?");
      
      const transaction = database.transaction(() => {
        for (let i = 0; i < chunksNeedingEmbedding.length; i++) {
          const chunk = chunksNeedingEmbedding[i];
          chunk.embedding = embeddings[i];
          updateStmt.run(serializeEmbedding(embeddings[i]), chunk.id);
        }
      });
      
      transaction();
    } catch (error) {
      console.warn("[VectorStore] Batch embedding failed, falling back to individual:", error);
      
      for (const chunk of chunksNeedingEmbedding) {
        try {
          chunk.embedding = await embed(chunk.text);
        } catch {
          // 개별 실패 무시
        }
      }
    }
  }
  
  // 코사인 유사도 계산 (최적화: Float32Array 사용)
  const results: SearchResult[] = [];
  const queryArr = new Float32Array(queryEmbedding);
  
  for (const chunk of chunks) {
    if (!chunk.embedding) continue;
    
    // 최적화된 내적 계산 (정규화된 벡터이므로 내적 = 코사인 유사도)
    let dotProduct = 0;
    const chunkEmb = chunk.embedding;
    for (let i = 0; i < queryArr.length; i++) {
      dotProduct += queryArr[i] * chunkEmb[i];
    }
    
    if (dotProduct >= minScore) {
      results.push({
        text: chunk.text,
        source: chunk.source,
        score: dotProduct,
      });
    }
  }
  
  // 정렬 및 상위 K개
  const sorted = results
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
  
  // 캐시 저장
  queryCache.set(cacheKey, { results: sorted, timestamp: Date.now() });
  pruneQueryCache();
  
  return sorted;
}

// ============================================
// 캐시 관리
// ============================================

/**
 * 청크 캐시 무효화
 */
export function invalidateCache(): void {
  chunkCache = [];
  chunkCacheTimestamp = 0;
  loadingPromise = null;
  queryCache.clear();
}

/**
 * 전체 캐시 및 DB 초기화
 */
export async function clearAll(): Promise<void> {
  invalidateCache();
  
  const database = getDb();
  database.exec("DELETE FROM chunks");
}

// ============================================
// 통계 및 유틸리티
// ============================================

/**
 * 저장소 통계 반환
 */
export function getStats(): { totalChunks: number; withEmbedding: number; sources: string[] } {
  const database = getDb();
  
  const countStmt = database.prepare("SELECT COUNT(*) as total FROM chunks");
  const embCountStmt = database.prepare("SELECT COUNT(*) as total FROM chunks WHERE embedding IS NOT NULL");
  const sourcesStmt = database.prepare("SELECT DISTINCT source FROM chunks");
  
  const total = (countStmt.get() as { total: number }).total;
  const withEmb = (embCountStmt.get() as { total: number }).total;
  const sources = (sourcesStmt.all() as Array<{ source: string }>).map(r => r.source);
  
  return {
    totalChunks: total,
    withEmbedding: withEmb,
    sources,
  };
}

/**
 * 벡터 저장소 사전 로드 (백그라운드 초기화)
 */
export async function preloadVectorStore(): Promise<void> {
  console.log("[VectorStore] Preloading...");
  const chunks = await loadAllMemoryChunks();
  console.log(`[VectorStore] Loaded ${chunks.length} chunks`);
}
