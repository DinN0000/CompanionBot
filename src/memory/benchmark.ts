/**
 * 메모리 검색 벤치마크
 * 
 * 사용법: npx tsx src/memory/benchmark.ts
 */

import { performance } from "perf_hooks";

// 현재 구현
import * as currentVector from "./vectorStore.js";
import * as currentFts from "./ftsIndex.js";
import * as currentHybrid from "./hybridSearch.js";

// 최적화 구현 (주석 해제하여 비교)
// import * as optimizedVector from "./vectorStore.optimized.js";
// import * as optimizedFts from "./ftsIndex.optimized.js";
// import * as optimizedHybrid from "./hybridSearch.optimized.js";

const TEST_QUERIES = [
  "오늘 무슨 일이 있었어?",
  "지난주 회의 내용",
  "프로젝트 마감일",
  "API 키 설정",
  "에러 해결 방법",
  "CompanionBot feature",
  "일정 확인",
  "메모리 검색 최적화",
  "테스트 코드 작성",
  "버그 수정",
];

interface BenchmarkResult {
  name: string;
  avgMs: number;
  minMs: number;
  maxMs: number;
  p95Ms: number;
  ops: number; // operations per second
}

async function benchmark(
  name: string,
  fn: () => Promise<unknown>,
  iterations: number = 10
): Promise<BenchmarkResult> {
  const times: number[] = [];
  
  // 워밍업
  await fn();
  await fn();
  
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    await fn();
    const end = performance.now();
    times.push(end - start);
  }
  
  times.sort((a, b) => a - b);
  
  const avgMs = times.reduce((a, b) => a + b, 0) / times.length;
  const p95Idx = Math.floor(times.length * 0.95);
  
  return {
    name,
    avgMs: Math.round(avgMs * 100) / 100,
    minMs: Math.round(times[0] * 100) / 100,
    maxMs: Math.round(times[times.length - 1] * 100) / 100,
    p95Ms: Math.round(times[p95Idx] * 100) / 100,
    ops: Math.round(1000 / avgMs),
  };
}

function printResult(result: BenchmarkResult): void {
  console.log(`
${result.name}:
  Average: ${result.avgMs}ms
  Min: ${result.minMs}ms
  Max: ${result.maxMs}ms
  P95: ${result.p95Ms}ms
  Ops/sec: ${result.ops}
`);
}

async function main() {
  console.log("=".repeat(60));
  console.log("Memory Search Benchmark");
  console.log("=".repeat(60));
  console.log(`\nTest queries: ${TEST_QUERIES.length}`);
  console.log(`Iterations per query: 10\n`);
  
  // 1. 벡터 검색 벤치마크
  console.log("\n--- Vector Search ---");
  
  for (const query of TEST_QUERIES.slice(0, 3)) {
    const result = await benchmark(
      `Vector search: "${query.slice(0, 20)}..."`,
      async () => {
        return currentHybrid.searchVector(query, 5, 0.3);
      },
      10
    );
    printResult(result);
  }
  
  // 2. FTS 검색 벤치마크
  console.log("\n--- FTS Keyword Search ---");
  
  for (const query of TEST_QUERIES.slice(0, 3)) {
    const result = await benchmark(
      `FTS search: "${query.slice(0, 20)}..."`,
      async () => {
        return currentFts.searchKeyword(query, 10);
      },
      10
    );
    printResult(result);
  }
  
  // 3. 하이브리드 검색 벤치마크
  console.log("\n--- Hybrid Search ---");
  
  for (const query of TEST_QUERIES.slice(0, 3)) {
    const result = await benchmark(
      `Hybrid search: "${query.slice(0, 20)}..."`,
      async () => {
        return currentHybrid.hybridSearch(query, { topK: 5 });
      },
      10
    );
    printResult(result);
  }
  
  // 4. 청크 로딩 벤치마크
  console.log("\n--- Chunk Loading ---");
  
  // 캐시 무효화 후 로딩 시간
  currentVector.invalidateCache();
  const loadResult = await benchmark(
    "Load all chunks (cold)",
    async () => {
      currentVector.invalidateCache();
      return currentVector.loadAllMemoryChunks();
    },
    5
  );
  printResult(loadResult);
  
  // 캐시된 로딩 시간
  const cachedLoadResult = await benchmark(
    "Load all chunks (cached)",
    async () => {
      return currentVector.loadAllMemoryChunks();
    },
    10
  );
  printResult(cachedLoadResult);
  
  // 5. 통계
  console.log("\n--- Statistics ---");
  const chunks = await currentVector.loadAllMemoryChunks();
  const ftsCount = currentFts.getDocumentCount();
  console.log(`Total chunks in vector store: ${chunks.length}`);
  console.log(`Total documents in FTS: ${ftsCount}`);
  
  console.log("\n" + "=".repeat(60));
  console.log("Benchmark complete");
  console.log("=".repeat(60));
}

main().catch(console.error);
