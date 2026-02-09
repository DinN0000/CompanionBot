import { loadWorkspace, type Workspace } from "../../workspace/index.js";

// 워크스페이스 캐시
let cachedWorkspace: Workspace | null = null;
let workspaceCacheTime = 0;
let loadingPromise: Promise<Workspace> | null = null;
const CACHE_TTL = 300000; // 5분

// 성능 측정용
let lastLoadTime = 0;

/**
 * 캐시된 워크스페이스를 반환합니다.
 * 캐시가 만료되었거나 없으면 새로 로드합니다.
 */
export async function getWorkspace(): Promise<Workspace> {
  const now = Date.now();

  // 캐시가 유효하면 바로 반환
  if (cachedWorkspace && now - workspaceCacheTime <= CACHE_TTL) {
    return cachedWorkspace;
  }

  // 이미 로딩 중이면 해당 Promise 반환 (중복 호출 방지)
  if (loadingPromise) {
    return loadingPromise;
  }

  // 새로 로드
  const startTime = Date.now();
  loadingPromise = loadWorkspace();
  try {
    cachedWorkspace = await loadingPromise;
    workspaceCacheTime = Date.now();
    lastLoadTime = Date.now() - startTime;
    return cachedWorkspace;
  } finally {
    loadingPromise = null;
  }
}

/**
 * 🚀 워크스페이스를 미리 로드합니다. (Warm-up용)
 * 봇 시작 시 백그라운드에서 호출하면 첫 메시지 응답 시간이 단축됩니다.
 * 
 * @returns 로딩 소요 시간 (ms), 이미 캐시되어 있으면 0
 */
export async function preloadWorkspace(): Promise<number> {
  const now = Date.now();
  
  // 이미 캐시되어 있으면 스킵
  if (cachedWorkspace && now - workspaceCacheTime <= CACHE_TTL) {
    return 0;
  }
  
  const startTime = Date.now();
  await getWorkspace();
  const loadTime = Date.now() - startTime;
  console.log(`[Workspace] Preloaded in ${loadTime}ms`);
  return loadTime;
}

/**
 * 워크스페이스가 캐시되어 있는지 확인합니다.
 */
export function isWorkspaceCached(): boolean {
  const now = Date.now();
  return cachedWorkspace !== null && now - workspaceCacheTime <= CACHE_TTL;
}

/**
 * 마지막 로드 소요 시간을 반환합니다.
 */
export function getLastLoadTime(): number {
  return lastLoadTime;
}

/**
 * 워크스페이스 캐시를 무효화합니다.
 */
export function invalidateWorkspaceCache(): void {
  cachedWorkspace = null;
  workspaceCacheTime = 0;
  loadingPromise = null;
}
