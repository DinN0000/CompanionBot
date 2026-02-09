/**
 * 메모리 인덱서 모듈
 * 현재 구현은 vectorStore가 on-demand로 로드하므로 캐시 무효화만 수행
 */

import { invalidateCache } from './vectorStore.js';

// 단일 파일 인덱싱 (캐시 무효화)
export async function indexFile(_filePath: string, _source: string): Promise<number> {
  // vectorStore가 on-demand로 로드하므로 캐시만 무효화
  invalidateCache();
  return 1;
}

// MEMORY.md 인덱싱
export async function indexMainMemory(): Promise<number> {
  invalidateCache();
  return 1;
}

// 일일 메모리 파일들 인덱싱
export async function indexDailyMemories(_days: number = 30): Promise<number> {
  invalidateCache();
  return 1;
}

// 전체 리인덱싱 (캐시 무효화 후 미리 로드)
export async function reindexAll(): Promise<{ total: number; sources: string[] }> {
  console.log('[Indexer] Invalidating cache for reindex...');
  invalidateCache();
  
  // 캐시 무효화 후 즉시 로드하여 청크 수 반환
  // search를 임시로 호출하여 로드 트리거 (빈 쿼리로)
  const { loadAllMemoryChunks } = await import('./vectorStore.js');
  const chunks = await loadAllMemoryChunks();
  
  // 소스별 집계
  const sourceCounts = new Map<string, number>();
  for (const chunk of chunks) {
    sourceCounts.set(chunk.source, (sourceCounts.get(chunk.source) || 0) + 1);
  }
  
  return { 
    total: chunks.length, 
    sources: Array.from(sourceCounts.keys())
  };
}
