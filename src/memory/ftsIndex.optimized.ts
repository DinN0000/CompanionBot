/**
 * 최적화된 FTS5 키워드 검색 인덱스 v2
 * 
 * 개선사항:
 * 1. trigram tokenizer 추가 (한국어 부분 매칭)
 * 2. 시간 기반 필터링 (timestamp 컬럼)
 * 3. 쿼리 캐싱
 * 4. 접두사/구문 검색 지원
 * 5. 하이라이트 기능
 */

import Database from "better-sqlite3";
import * as path from "path";
import { getMemoryDirPath } from "../workspace/paths.js";

// ============================================
// 타입 정의
// ============================================

export interface FtsEntry {
  id: string;
  source: string;
  text: string;
  timestamp?: number;
}

export interface FtsSearchResult {
  id: string;
  source: string;
  text: string;
  score: number;
  highlight?: string;
}

export interface FtsSearchOptions {
  limit?: number;
  maxAgeDays?: number;
  sources?: string[];
  usePrefix?: boolean;    // 접두사 검색 사용
  usePhrase?: boolean;    // 구문 검색 사용
  highlight?: boolean;    // 하이라이트 반환
}

// ============================================
// 싱글톤 DB 및 캐시
// ============================================

let db: Database.Database | null = null;

// 쿼리 캐시
const queryCache = new Map<string, { results: FtsSearchResult[]; timestamp: number }>();
const QUERY_CACHE_MAX = 50;
const QUERY_CACHE_TTL_MS = 30 * 1000; // 30초

// ============================================
// 데이터베이스 관리
// ============================================

function getDbPath(): string {
  return path.join(getMemoryDirPath(), ".fts-index-v2.db");
}

function getDb(): Database.Database {
  if (db) return db;

  const dbPath = getDbPath();
  db = new Database(dbPath);
  
  // WAL 모드
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");

  // 메인 FTS5 테이블 (unicode61 토크나이저)
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
      id UNINDEXED,
      source,
      text,
      timestamp UNINDEXED,
      content='',
      tokenize='unicode61 remove_diacritics 2'
    );
  `);
  
  // trigram 테이블 (한국어/부분 매칭용)
  // trigram은 3글자 단위로 인덱싱하여 부분 문자열 검색 지원
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts_trigram USING fts5(
      id UNINDEXED,
      source,
      text,
      content='',
      tokenize='trigram'
    );
  `);
  
  // timestamp 인덱스용 보조 테이블
  db.exec(`
    CREATE TABLE IF NOT EXISTS fts_metadata (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      timestamp INTEGER NOT NULL
    );
    
    CREATE INDEX IF NOT EXISTS idx_fts_meta_source ON fts_metadata(source);
    CREATE INDEX IF NOT EXISTS idx_fts_meta_timestamp ON fts_metadata(timestamp DESC);
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
// 인덱싱
// ============================================

/**
 * 단일 텍스트 인덱싱
 */
export function indexText(id: string, source: string, text: string, timestamp?: number): void {
  const database = getDb();
  const ts = timestamp || Date.now();

  const transaction = database.transaction(() => {
    // 기존 삭제
    database.prepare("DELETE FROM memory_fts WHERE id = ?").run(id);
    database.prepare("DELETE FROM memory_fts_trigram WHERE id = ?").run(id);
    database.prepare("DELETE FROM fts_metadata WHERE id = ?").run(id);
    
    // 새로 삽입
    database.prepare(
      "INSERT INTO memory_fts (id, source, text, timestamp) VALUES (?, ?, ?, ?)"
    ).run(id, source, text, ts);
    
    database.prepare(
      "INSERT INTO memory_fts_trigram (id, source, text) VALUES (?, ?, ?)"
    ).run(id, source, text);
    
    database.prepare(
      "INSERT INTO fts_metadata (id, source, timestamp) VALUES (?, ?, ?)"
    ).run(id, source, ts);
  });

  transaction();
  invalidateQueryCache();
}

/**
 * 배치 인덱싱
 */
export function indexTextBatch(entries: FtsEntry[]): void {
  if (entries.length === 0) return;

  const database = getDb();
  
  const deleteFts = database.prepare("DELETE FROM memory_fts WHERE id = ?");
  const deleteTrigram = database.prepare("DELETE FROM memory_fts_trigram WHERE id = ?");
  const deleteMeta = database.prepare("DELETE FROM fts_metadata WHERE id = ?");
  
  const insertFts = database.prepare(
    "INSERT INTO memory_fts (id, source, text, timestamp) VALUES (?, ?, ?, ?)"
  );
  const insertTrigram = database.prepare(
    "INSERT INTO memory_fts_trigram (id, source, text) VALUES (?, ?, ?)"
  );
  const insertMeta = database.prepare(
    "INSERT INTO fts_metadata (id, source, timestamp) VALUES (?, ?, ?)"
  );

  const transaction = database.transaction(() => {
    for (const entry of entries) {
      const ts = entry.timestamp || Date.now();
      
      deleteFts.run(entry.id);
      deleteTrigram.run(entry.id);
      deleteMeta.run(entry.id);
      
      insertFts.run(entry.id, entry.source, entry.text, ts);
      insertTrigram.run(entry.id, entry.source, entry.text);
      insertMeta.run(entry.id, entry.source, ts);
    }
  });

  transaction();
  invalidateQueryCache();
}

// ============================================
// 검색
// ============================================

/**
 * 쿼리 정규화 (단어 기반)
 */
function normalizeQuery(query: string, options: FtsSearchOptions): string {
  // 특수문자 제거
  const clean = query
    .replace(/[^\w\s가-힣ㄱ-ㅎㅏ-ㅣ]/g, " ")
    .trim();
  
  const words = clean.split(/\s+/).filter(w => w.length > 0);
  if (words.length === 0) return "";
  
  if (options.usePhrase) {
    // 구문 검색: "word1 word2 word3"
    return `"${words.join(" ")}"`;
  }
  
  if (options.usePrefix) {
    // 접두사 검색: word1* OR word2*
    return words.map(w => `${w}*`).join(" OR ");
  }
  
  // 기본: OR 검색
  return words.map(w => `"${w}"`).join(" OR ");
}

/**
 * 캐시 키 생성
 */
function makeCacheKey(query: string, options: FtsSearchOptions): string {
  return `${query}:${options.limit}:${options.maxAgeDays}:${options.sources?.join(",")}:${options.usePrefix}:${options.usePhrase}`;
}

/**
 * 캐시 정리
 */
function pruneQueryCache(): void {
  if (queryCache.size <= QUERY_CACHE_MAX) return;
  
  const entries = Array.from(queryCache.entries());
  entries.sort((a, b) => a[1].timestamp - b[1].timestamp);
  
  const toDelete = entries.slice(0, Math.floor(QUERY_CACHE_MAX / 2));
  for (const [key] of toDelete) {
    queryCache.delete(key);
  }
}

/**
 * 캐시 무효화
 */
function invalidateQueryCache(): void {
  queryCache.clear();
}

/**
 * 키워드 검색 (메인)
 */
export function searchKeyword(
  query: string,
  limit: number = 10,
  options: Omit<FtsSearchOptions, "limit"> = {}
): FtsSearchResult[] {
  const searchOptions: FtsSearchOptions = { limit, ...options };
  
  // 캐시 확인
  const cacheKey = makeCacheKey(query, searchOptions);
  const cached = queryCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < QUERY_CACHE_TTL_MS) {
    return cached.results;
  }
  
  const database = getDb();
  const normalizedQuery = normalizeQuery(query, searchOptions);
  
  if (!normalizedQuery) return [];
  
  try {
    // 시간/소스 필터가 있으면 메타데이터 조인
    let sql: string;
    const params: (string | number)[] = [];
    
    const selectCols = options.highlight
      ? "f.id, f.source, highlight(memory_fts, 2, '<mark>', '</mark>') as text, bm25(memory_fts) as score"
      : "f.id, f.source, f.text, bm25(memory_fts) as score";
    
    if (searchOptions.maxAgeDays || (searchOptions.sources && searchOptions.sources.length > 0)) {
      sql = `
        SELECT ${selectCols}
        FROM memory_fts f
        JOIN fts_metadata m ON f.id = m.id
        WHERE memory_fts MATCH ?
      `;
      params.push(normalizedQuery);
      
      if (searchOptions.maxAgeDays) {
        const cutoff = Date.now() - (searchOptions.maxAgeDays * 24 * 60 * 60 * 1000);
        sql += " AND m.timestamp >= ?";
        params.push(cutoff);
      }
      
      if (searchOptions.sources && searchOptions.sources.length > 0) {
        const placeholders = searchOptions.sources.map(() => "?").join(", ");
        sql += ` AND m.source IN (${placeholders})`;
        params.push(...searchOptions.sources);
      }
      
      sql += " ORDER BY score LIMIT ?";
      params.push(limit);
    } else {
      sql = `
        SELECT ${selectCols}
        FROM memory_fts f
        WHERE memory_fts MATCH ?
        ORDER BY score
        LIMIT ?
      `;
      params.push(normalizedQuery, limit);
    }
    
    const stmt = database.prepare(sql);
    const results = stmt.all(...params) as FtsSearchResult[];
    
    // 캐시 저장
    queryCache.set(cacheKey, { results, timestamp: Date.now() });
    pruneQueryCache();
    
    return results;
  } catch {
    return [];
  }
}

/**
 * trigram 검색 (부분 문자열 매칭 - 한국어에 유용)
 */
export function searchTrigram(query: string, limit: number = 10): FtsSearchResult[] {
  const database = getDb();
  
  // trigram은 최소 3글자 필요
  const clean = query.replace(/\s+/g, "").trim();
  if (clean.length < 3) {
    // 3글자 미만이면 일반 검색으로 폴백
    return searchKeyword(query, limit);
  }
  
  try {
    const stmt = database.prepare(`
      SELECT id, source, text, bm25(memory_fts_trigram) as score
      FROM memory_fts_trigram
      WHERE memory_fts_trigram MATCH ?
      ORDER BY score
      LIMIT ?
    `);
    
    // trigram 쿼리는 그대로 전달 (내부적으로 3글자씩 분리)
    const results = stmt.all(`"${clean}"`, limit) as FtsSearchResult[];
    return results;
  } catch {
    return [];
  }
}

/**
 * 하이브리드 검색 (unicode61 + trigram 결합)
 * 한국어/영어 혼합 쿼리에 효과적
 */
export function searchHybridKeyword(query: string, limit: number = 10): FtsSearchResult[] {
  // 두 검색 결과 병합
  const unicodeResults = searchKeyword(query, limit);
  const trigramResults = searchTrigram(query, limit);
  
  // 중복 제거 및 점수 결합
  const resultMap = new Map<string, FtsSearchResult>();
  
  for (const r of unicodeResults) {
    resultMap.set(r.id, r);
  }
  
  for (const r of trigramResults) {
    const existing = resultMap.get(r.id);
    if (existing) {
      // 점수 결합 (낮을수록 좋음)
      existing.score = Math.min(existing.score, r.score);
    } else {
      resultMap.set(r.id, r);
    }
  }
  
  // 점수순 정렬
  return Array.from(resultMap.values())
    .sort((a, b) => a.score - b.score)
    .slice(0, limit);
}

// ============================================
// 삭제 및 관리
// ============================================

/**
 * 소스별 삭제
 */
export function deleteBySource(source: string): number {
  const database = getDb();
  
  const transaction = database.transaction(() => {
    database.prepare("DELETE FROM memory_fts WHERE source = ?").run(source);
    database.prepare("DELETE FROM memory_fts_trigram WHERE source = ?").run(source);
    database.prepare("DELETE FROM fts_metadata WHERE source = ?").run(source);
  });
  
  transaction();
  invalidateQueryCache();
  
  // 변경 수는 정확히 알 수 없으므로 근사값
  return 0;
}

/**
 * ID별 삭제
 */
export function deleteById(id: string): boolean {
  const database = getDb();
  
  const transaction = database.transaction(() => {
    database.prepare("DELETE FROM memory_fts WHERE id = ?").run(id);
    database.prepare("DELETE FROM memory_fts_trigram WHERE id = ?").run(id);
    database.prepare("DELETE FROM fts_metadata WHERE id = ?").run(id);
  });
  
  transaction();
  invalidateQueryCache();
  
  return true;
}

/**
 * 전체 인덱스 초기화
 */
export function clearIndex(): void {
  const database = getDb();
  
  const transaction = database.transaction(() => {
    database.exec("DELETE FROM memory_fts");
    database.exec("DELETE FROM memory_fts_trigram");
    database.exec("DELETE FROM fts_metadata");
  });
  
  transaction();
  invalidateQueryCache();
}

/**
 * 문서 수 반환
 */
export function getDocumentCount(): number {
  const database = getDb();
  const stmt = database.prepare("SELECT COUNT(*) as count FROM fts_metadata");
  const result = stmt.get() as { count: number };
  return result.count;
}

/**
 * 통계 반환
 */
export function getStats(): { totalDocs: number; sources: string[]; oldestTimestamp: number | null } {
  const database = getDb();
  
  const countStmt = database.prepare("SELECT COUNT(*) as count FROM fts_metadata");
  const sourcesStmt = database.prepare("SELECT DISTINCT source FROM fts_metadata");
  const oldestStmt = database.prepare("SELECT MIN(timestamp) as oldest FROM fts_metadata");
  
  const count = (countStmt.get() as { count: number }).count;
  const sources = (sourcesStmt.all() as Array<{ source: string }>).map(r => r.source);
  const oldest = (oldestStmt.get() as { oldest: number | null }).oldest;
  
  return {
    totalDocs: count,
    sources,
    oldestTimestamp: oldest,
  };
}
