/**
 * 전역 상수 설정
 * 하드코딩된 매직 넘버들을 한 곳에서 관리
 */

// ============================================
// 세션 관련 설정
// ============================================
export const SESSION = {
  /** 최대 동시 세션 수 (LRU 정리) */
  MAX_SESSIONS: 100,
  
  /** 세션 TTL (밀리초) - 24시간 */
  TTL_MS: 24 * 60 * 60 * 1000,
  
  /** 메모리에 로드할 최대 히스토리 메시지 수 */
  MAX_HISTORY_LOAD: 50,
} as const;

// ============================================
// 토큰/컨텍스트 관련 설정
// ============================================
export const TOKENS = {
  /** Claude 최대 컨텍스트 토큰 */
  MAX_CONTEXT: 100000,
  
  /** 히스토리 토큰 한도 */
  MAX_HISTORY: 40000,
  
  /** 이 이상이면 자동 요약 시작 */
  SUMMARY_THRESHOLD: 25000,
  
  /** 핀 맥락 최대 토큰 */
  MAX_PINNED: 5000,
  
  /** 자동 압축 시작 비율 (0.35 = 35%) */
  COMPACTION_THRESHOLD: 0.35,
  
  /** compact 스킵 기준 토큰 */
  COMPACT_MIN_TOKENS: 5000,
} as const;

// ============================================
// 메시지 관련 설정
// ============================================
export const MESSAGES = {
  /** 트리밍 시 최소 유지할 최근 메시지 수 */
  MIN_RECENT: 6,
  
  /** compact 시 유지할 최근 메시지 수 */
  KEEP_ON_COMPACT: 4,
  
  /** 최대 요약 청크 수 */
  MAX_SUMMARY_CHUNKS: 3,
  
  /** 검색 기본 결과 수 */
  SEARCH_LIMIT: 10,
  
  /** 히스토리 로드 기본 limit */
  HISTORY_LOAD_LIMIT: 100,
} as const;

// ============================================
// 메모리/벡터 저장소 설정
// ============================================
export const MEMORY = {
  /** 벡터 캐시 TTL (밀리초) - 5분 */
  CACHE_TTL_MS: 5 * 60 * 1000,
  
  /** 최소 청크 길이 (이하는 무시) */
  MIN_CHUNK_LENGTH: 20,
  
  /** 최대 청크 길이 (초과 시 분할) */
  MAX_CHUNK_LENGTH: 500,
  
  /** 로드할 최근 메모리 파일 일수 */
  RECENT_DAYS: 30,
  
  /** 벡터 검색 기본 topK */
  SEARCH_TOP_K: 5,
  
  /** 벡터 검색 최소 유사도 점수 */
  MIN_SIMILARITY: 0.3,
  
  /** /memory 명령어 표시 일수 */
  DISPLAY_DAYS: 7,
  
  /** /memory 최대 표시 길이 */
  MAX_DISPLAY_LENGTH: 2000,
} as const;

// ============================================
// 텔레그램/UI 관련 설정
// ============================================
export const TELEGRAM = {
  /** 스트리밍 업데이트 간격 - 적응형 (밀리초) */
  STREAM_UPDATE_INTERVAL_MS: 500,  // 레거시 호환용
  
  /** 스트리밍 적응형 간격 설정 */
  STREAM_INTERVAL: {
    /** 첫 번째 업데이트 (즉시) */
    FIRST_MS: 0,
    /** 초기 빠른 업데이트 (처음 5회) */
    FAST_MS: 200,
    /** 이후 일반 간격 */
    NORMAL_MS: 400,
    /** 빠른 업데이트 횟수 */
    FAST_COUNT: 5,
  },
  
  /** 텔레그램 메시지 최대 길이 */
  MAX_MESSAGE_LENGTH: 4096,
  
  /** 최대 이미지 크기 (바이트) - 10MB */
  MAX_IMAGE_SIZE: 10 * 1024 * 1024,
  
  /** URL 처리 최대 개수 */
  MAX_URL_FETCH: 3,
  
  /** 캘린더 미리보기 이벤트 수 */
  CALENDAR_PREVIEW_COUNT: 3,
  
  /** 스트리밍 UI 아이콘 */
  STREAM_ICONS: {
    THINKING: "💭",
    TYPING: "▌",
    TOOL: "🔧",
    DONE: "",
  },
  
  /** Typing indicator 자동 갱신 간격 (밀리초) - 텔레그램은 5초 후 만료 */
  TYPING_REFRESH_MS: 4000,
  
  /** 도구별 친화적 상태 메시지 */
  TOOL_STATUS_MESSAGES: {
    // 검색/정보 조회
    web_search: { icon: "🔍", text: "웹에서 검색하는 중", estimate: "5-10초" },
    web_fetch: { icon: "📄", text: "웹페이지 읽는 중", estimate: "3-5초" },
    get_weather: { icon: "🌤️", text: "날씨 확인 중", estimate: "2-3초" },
    memory_search: { icon: "🧠", text: "기억 검색 중", estimate: "1-2초" },
    memory_reindex: { icon: "🧠", text: "기억 재색인 중", estimate: "10-30초" },
    
    // 파일 작업
    read_file: { icon: "📖", text: "파일 읽는 중", estimate: "1초" },
    write_file: { icon: "✍️", text: "파일 쓰는 중", estimate: "1초" },
    edit_file: { icon: "✏️", text: "파일 수정 중", estimate: "1초" },
    list_directory: { icon: "📁", text: "폴더 살펴보는 중", estimate: "1초" },
    
    // 명령어 실행
    run_command: { icon: "⚡", text: "명령어 실행 중", estimate: "변동" },
    list_sessions: { icon: "📋", text: "세션 목록 확인 중", estimate: "1초" },
    get_session_log: { icon: "📜", text: "로그 가져오는 중", estimate: "1초" },
    kill_session: { icon: "🛑", text: "세션 종료 중", estimate: "1초" },
    
    // 일정/리마인더
    get_calendar_events: { icon: "📅", text: "일정 확인 중", estimate: "2-3초" },
    add_calendar_event: { icon: "📅", text: "일정 추가 중", estimate: "2-3초" },
    delete_calendar_event: { icon: "📅", text: "일정 삭제 중", estimate: "2초" },
    set_reminder: { icon: "⏰", text: "알림 설정 중", estimate: "1초" },
    list_reminders: { icon: "⏰", text: "알림 목록 확인 중", estimate: "1초" },
    cancel_reminder: { icon: "⏰", text: "알림 취소 중", estimate: "1초" },
    
    // 브리핑/하트비트
    control_briefing: { icon: "☀️", text: "브리핑 설정 중", estimate: "1초" },
    send_briefing_now: { icon: "☀️", text: "브리핑 준비 중", estimate: "5-10초" },
    control_heartbeat: { icon: "💓", text: "하트비트 설정 중", estimate: "1초" },
    run_heartbeat_check: { icon: "💓", text: "체크 실행 중", estimate: "3-5초" },
    
    // 서브에이전트
    spawn_agent: { icon: "🤖", text: "서브에이전트 생성 중", estimate: "2-3초" },
    list_agents: { icon: "🤖", text: "에이전트 목록 확인 중", estimate: "1초" },
    cancel_agent: { icon: "🤖", text: "에이전트 취소 중", estimate: "1초" },
    
    // Cron
    add_cron: { icon: "🕐", text: "예약 작업 추가 중", estimate: "1초" },
    list_crons: { icon: "🕐", text: "예약 작업 확인 중", estimate: "1초" },
    remove_cron: { icon: "🕐", text: "예약 작업 삭제 중", estimate: "1초" },
    toggle_cron: { icon: "🕐", text: "예약 작업 설정 중", estimate: "1초" },
    run_cron: { icon: "🕐", text: "예약 작업 실행 중", estimate: "변동" },
    
    // 기타
    change_model: { icon: "🔄", text: "모델 변경 중", estimate: "1초" },
    save_memory: { icon: "💾", text: "기억 저장 중", estimate: "1초" },
    save_persona: { icon: "✨", text: "페르소나 저장 중", estimate: "2초" },
  } as Record<string, { icon: string; text: string; estimate: string }>,
} as const;

// ============================================
// 보안/토큰 관련 설정
// ============================================
export const SECURITY = {
  /** 리셋 토큰 만료 시간 (밀리초) - 1분 */
  RESET_TOKEN_TTL_MS: 60000,
} as const;

// ============================================
// API/네트워크 설정
// ============================================
export const API = {
  /** Claude API 타임아웃 (밀리초) - 2분 */
  TIMEOUT_MS: 120000,
  
  /** 최대 재시도 횟수 */
  MAX_RETRIES: 3,
  
  /** 초기 재시도 대기 시간 (밀리초) */
  INITIAL_RETRY_DELAY_MS: 1000,
  
  /** 최대 재시도 대기 시간 (밀리초) */
  MAX_RETRY_DELAY_MS: 30000,
  
  /** 재시도 백오프 배수 */
  BACKOFF_MULTIPLIER: 2,
} as const;

// ============================================
// 메모리 검색 타임아웃 설정
// ============================================
export const SEARCH = {
  /** 전체 검색 타임아웃 (밀리초) */
  TIMEOUT_MS: 5000,
  
  /** 임베딩 생성 타임아웃 (밀리초) */
  EMBED_TIMEOUT_MS: 3000,
} as const;
