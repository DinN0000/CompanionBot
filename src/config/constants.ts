/**
 * 전역 상수 설정
 * 
 * 하드코딩된 매직 넘버들을 한 곳에서 관리
 * 환경변수로 오버라이드 가능
 */

// 환경변수에서 숫자 읽기 (기본값 사용)
function envInt(key: string, defaultValue: number): number {
  const val = process.env[key];
  if (!val) return defaultValue;
  const parsed = parseInt(val, 10);
  return isNaN(parsed) ? defaultValue : parsed;
}

function envFloat(key: string, defaultValue: number): number {
  const val = process.env[key];
  if (!val) return defaultValue;
  const parsed = parseFloat(val);
  return isNaN(parsed) ? defaultValue : parsed;
}

// ============================================
// 세션 관련 설정
// ============================================
export const SESSION = {
  /** 최대 동시 세션 수 (LRU 정리) */
  MAX_SESSIONS: envInt("CB_MAX_SESSIONS", 100),
  
  /** 세션 TTL (밀리초) - 기본 24시간 */
  TTL_MS: envInt("CB_SESSION_TTL_MS", 24 * 60 * 60 * 1000),
  
  /** 메모리에 로드할 최대 히스토리 메시지 수 */
  MAX_HISTORY_LOAD: envInt("CB_MAX_HISTORY_LOAD", 50),
} as const;

// ============================================
// 토큰/컨텍스트 관련 설정
// ============================================
export const TOKENS = {
  /** Claude 최대 컨텍스트 토큰 */
  MAX_CONTEXT: envInt("CB_MAX_CONTEXT_TOKENS", 100000),
  
  /** 히스토리 토큰 한도 */
  MAX_HISTORY: envInt("CB_MAX_HISTORY_TOKENS", 40000),
  
  /** 이 이상이면 자동 요약 시작 */
  SUMMARY_THRESHOLD: envInt("CB_SUMMARY_THRESHOLD_TOKENS", 25000),
  
  /** 핀 맥락 최대 토큰 */
  MAX_PINNED: envInt("CB_MAX_PINNED_TOKENS", 5000),
  
  /** 자동 압축 시작 비율 (0.35 = 35%) */
  COMPACTION_THRESHOLD: envFloat("CB_COMPACTION_THRESHOLD", 0.35),
  
  /** compact 스킵 기준 토큰 */
  COMPACT_MIN_TOKENS: envInt("CB_COMPACT_MIN_TOKENS", 5000),
} as const;

// ============================================
// 메시지 관련 설정
// ============================================
export const MESSAGES = {
  /** 트리밍 시 최소 유지할 최근 메시지 수 */
  MIN_RECENT: envInt("CB_MIN_RECENT_MESSAGES", 6),
  
  /** compact 시 유지할 최근 메시지 수 */
  KEEP_ON_COMPACT: envInt("CB_KEEP_ON_COMPACT", 4),
  
  /** 최대 요약 청크 수 */
  MAX_SUMMARY_CHUNKS: envInt("CB_MAX_SUMMARY_CHUNKS", 3),
  
  /** 검색 기본 결과 수 */
  SEARCH_LIMIT: envInt("CB_SEARCH_LIMIT", 10),
  
  /** 히스토리 로드 기본 limit */
  HISTORY_LOAD_LIMIT: envInt("CB_HISTORY_LOAD_LIMIT", 100),
} as const;

// ============================================
// 메모리/벡터 저장소 설정
// ============================================
export const MEMORY = {
  /** 벡터 캐시 TTL (밀리초) - 기본 5분 */
  CACHE_TTL_MS: envInt("CB_MEMORY_CACHE_TTL_MS", 5 * 60 * 1000),
  
  /** 최소 청크 길이 (이하는 무시) */
  MIN_CHUNK_LENGTH: envInt("CB_MIN_CHUNK_LENGTH", 20),
  
  /** 최대 청크 길이 (초과 시 분할) */
  MAX_CHUNK_LENGTH: envInt("CB_MAX_CHUNK_LENGTH", 500),
  
  /** 로드할 최근 메모리 파일 일수 */
  RECENT_DAYS: envInt("CB_MEMORY_RECENT_DAYS", 30),
  
  /** 벡터 검색 기본 topK */
  SEARCH_TOP_K: envInt("CB_VECTOR_SEARCH_TOP_K", 5),
  
  /** 벡터 검색 최소 유사도 점수 */
  MIN_SIMILARITY: envFloat("CB_MIN_SIMILARITY", 0.3),
  
  /** /memory 명령어 표시 일수 */
  DISPLAY_DAYS: envInt("CB_MEMORY_DISPLAY_DAYS", 7),
  
  /** /memory 최대 표시 길이 */
  MAX_DISPLAY_LENGTH: envInt("CB_MEMORY_MAX_DISPLAY_LENGTH", 2000),
} as const;

// ============================================
// 텔레그램/UI 관련 설정
// ============================================
export const TELEGRAM = {
  /** 스트리밍 업데이트 간격 (밀리초) */
  STREAM_UPDATE_INTERVAL_MS: envInt("CB_STREAM_UPDATE_INTERVAL_MS", 500),
  
  /** 최대 이미지 크기 (바이트) - 기본 10MB */
  MAX_IMAGE_SIZE: envInt("CB_MAX_IMAGE_SIZE", 10 * 1024 * 1024),
  
  /** URL 처리 최대 개수 */
  MAX_URL_FETCH: envInt("CB_MAX_URL_FETCH", 3),
  
  /** 캘린더 미리보기 이벤트 수 */
  CALENDAR_PREVIEW_COUNT: envInt("CB_CALENDAR_PREVIEW_COUNT", 3),
} as const;

// ============================================
// 보안/토큰 관련 설정
// ============================================
export const SECURITY = {
  /** 리셋 토큰 만료 시간 (밀리초) - 기본 1분 */
  RESET_TOKEN_TTL_MS: envInt("CB_RESET_TOKEN_TTL_MS", 60000),
} as const;
