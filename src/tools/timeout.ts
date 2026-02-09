/**
 * Tool timeout utilities
 */

// 도구별 타임아웃 (ms)
export const TOOL_TIMEOUTS: Record<string, number> = {
  // 파일 작업 (빠름)
  read_file: 5000,
  write_file: 5000,
  edit_file: 5000,
  list_directory: 3000,
  
  // 메모리 작업
  save_memory: 3000,
  save_persona: 5000,
  memory_search: 10000,
  memory_reindex: 30000,
  
  // 네트워크 도구
  web_search: 15000,
  web_fetch: 20000,
  get_weather: 10000,
  
  // 캘린더 (Google API)
  get_calendar_events: 15000,
  add_calendar_event: 15000,
  delete_calendar_event: 10000,
  
  // 리마인더/크론 (로컬)
  set_reminder: 3000,
  list_reminders: 2000,
  cancel_reminder: 2000,
  add_cron: 3000,
  list_crons: 2000,
  remove_cron: 2000,
  toggle_cron: 2000,
  run_cron: 5000,
  
  // 세션 관리
  list_sessions: 2000,
  get_session_log: 3000,
  kill_session: 5000,
  
  // 명령 실행 - 별도 처리 (run_command는 자체 timeout 파라미터 있음)
  run_command: 60000, // 최대 fallback
  
  // Heartbeat/Briefing
  control_heartbeat: 3000,
  run_heartbeat_check: 30000,
  control_briefing: 3000,
  send_briefing_now: 30000,
  
  // Sub-agent
  spawn_agent: 5000,
  list_agents: 2000,
  cancel_agent: 3000,
  
  // 모델 변경
  change_model: 1000,
};

// 기본 타임아웃
export const DEFAULT_TOOL_TIMEOUT = 30000;

/**
 * 타임아웃과 함께 함수 실행
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  errorMessage: string
): Promise<T> {
  let timeoutId: NodeJS.Timeout;
  
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(errorMessage));
    }, timeoutMs);
  });
  
  try {
    const result = await Promise.race([promise, timeoutPromise]);
    clearTimeout(timeoutId!);
    return result;
  } catch (error) {
    clearTimeout(timeoutId!);
    throw error;
  }
}

/**
 * 도구별 타임아웃 가져오기
 */
export function getToolTimeout(toolName: string): number {
  return TOOL_TIMEOUTS[toolName] ?? DEFAULT_TOOL_TIMEOUT;
}
