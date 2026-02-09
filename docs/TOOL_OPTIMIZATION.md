# CompanionBot 도구 최적화 분석 및 개선안

## 📊 현재 상태 분석

### 도구 정의 크기
- **총 도구 수:** 36개
- **tools 배열 크기:** 약 15KB (JSON 직렬화 기준)
- 매 API 요청마다 전체 도구 정의가 전송됨

### 병렬 실행 현황
- ❌ 현재 도구는 **순차 실행** (`for...of` 루프)
- Claude가 여러 도구를 요청해도 하나씩 처리

### 도구 결과 처리
- `TOOL_RESULT_MAX_LENGTH`: 10,000자
- 단순 truncate 방식 (정보 손실 가능)

### 타임아웃 설정
- `run_command` 기본 30초
- 기타 도구: 타임아웃 없음 (무한 대기 가능)

---

## 🚀 개선안

### 1. 도구 정의 압축 (토큰 절약)

**현재 문제:** 긴 description, 중복 정보
**예상 절감:** 30-40% 토큰 감소

```typescript
// Before
{
  name: "add_cron",
  description: `Create a scheduled cron job. Use when the user wants to schedule recurring tasks.

Schedule formats:
- Cron expression: "0 9 * * *" (9AM daily), "0 9 * * 1-5" (weekdays 9AM)
- Korean: "매일 아침 9시", "평일 오후 3시", "매주 월요일 10시"
- Interval: "30분마다", "2시간마다"
- One-time: "내일 오전 9시에", "2024-12-25 10:00"

Examples:
- "매일 아침 9시에 뉴스 알려줘" → name: "뉴스", schedule: "매일 아침 9시", payload: { kind: "agentTurn", message: "오늘 뉴스 요약해줘" }
- "평일 오후 6시에 퇴근 알림" → name: "퇴근알림", schedule: "0 18 * * 1-5", payload: { kind: "agentTurn", message: "퇴근 시간이에요!" }`,
  // ...
}

// After (압축)
{
  name: "add_cron",
  description: "Create scheduled task. schedule: cron/Korean time (e.g., '0 9 * * *', '매일 아침 9시', '30분마다')",
  // ...
}
```

### 2. 병렬 도구 실행

**현재:** 순차 실행
**개선:** `Promise.all()`로 병렬 처리

```typescript
// Before
for (const toolUse of toolUseBlocks) {
  const result = await executeTool(toolUse.name, toolUse.input);
  toolResults.push({ ... });
}

// After
const toolResults = await Promise.all(
  toolUseBlocks.map(async (toolUse) => {
    const result = await executeTool(toolUse.name, toolUse.input);
    return { type: "tool_result", tool_use_id: toolUse.id, content: result };
  })
);
```

**예상 효과:** 다중 도구 호출 시 50-70% 시간 단축

### 3. 도구 결과 스마트 압축

**현재:** 단순 truncate
**개선:** 도구별 맞춤 압축

```typescript
function compressToolResult(toolName: string, result: string): string {
  const maxLength = TOOL_RESULT_MAX_LENGTH;
  
  if (result.length <= maxLength) return result;
  
  switch (toolName) {
    case "web_search":
      // 상위 N개 결과만 유지
      return truncateSearchResults(result, 5);
    
    case "list_directory":
      // 파일 수 + 처음/끝 몇 개만
      return summarizeDirectory(result);
    
    case "read_file":
      // 앞부분 위주 + "... (X more lines)"
      return result.slice(0, maxLength * 0.8) + `\n... (${result.split('\n').length} total lines)`;
    
    default:
      return result.slice(0, maxLength) + "... (truncated)";
  }
}
```

### 4. 불필요한 도구 제거/통합

**통합 후보:**
| 현재 | 통합 제안 |
|------|----------|
| `list_sessions`, `get_session_log`, `kill_session` | `manage_session` (action 파라미터) |
| `control_heartbeat`, `run_heartbeat_check` | `heartbeat` (action 파라미터) |
| `control_briefing`, `send_briefing_now` | `briefing` (action 파라미터) |
| `list_reminders`, `cancel_reminder` | `set_reminder`에 통합 |
| `list_crons`, `remove_cron`, `toggle_cron`, `run_cron` | `manage_cron` (action 파라미터) |

**예상 절감:** 36개 → 25개 (약 30% 감소)

### 5. 도구별 타임아웃 설정

```typescript
const TOOL_TIMEOUTS: Record<string, number> = {
  // 빠른 도구
  read_file: 5000,
  write_file: 5000,
  list_directory: 3000,
  
  // 네트워크 도구
  web_search: 10000,
  web_fetch: 15000,
  get_weather: 10000,
  
  // 외부 API
  get_calendar_events: 10000,
  add_calendar_event: 10000,
  
  // 명령 실행 (기존 설정 유지)
  run_command: 30000,
  
  // 기본값
  default: 30000,
};

async function executeToolWithTimeout(name: string, input: Record<string, unknown>): Promise<string> {
  const timeout = TOOL_TIMEOUTS[name] || TOOL_TIMEOUTS.default;
  
  return Promise.race([
    executeTool(name, input),
    new Promise<string>((_, reject) => 
      setTimeout(() => reject(new Error(`Tool ${name} timed out after ${timeout}ms`)), timeout)
    ),
  ]);
}
```

---

## 📈 예상 성능 향상

| 개선 항목 | 효과 |
|----------|------|
| 도구 정의 압축 | API 비용 30-40% 절감 (토큰) |
| 병렬 실행 | 다중 도구 50-70% 시간 단축 |
| 스마트 압축 | 컨텍스트 활용도 향상, 비용 절감 |
| 도구 통합 | 관리 복잡도 감소, 파싱 시간 단축 |
| 타임아웃 | 안정성 향상, 행 방지 |

---

## 🔧 구현 우선순위

1. **[HIGH]** 병렬 도구 실행 - 즉각적인 성능 향상
2. **[HIGH]** 타임아웃 설정 - 안정성 필수
3. **[MEDIUM]** 도구 정의 압축 - 비용 절감
4. **[MEDIUM]** 스마트 결과 압축 - 컨텍스트 효율
5. **[LOW]** 도구 통합 - 대규모 리팩토링 필요

---

## 📁 구현 파일

- `src/tools/index.ts` - 도구 정의 및 실행
- `src/tools/timeout.ts` - 타임아웃 유틸리티 (신규)
- `src/tools/compress.ts` - 결과 압축 (신규)
- `src/ai/claude.ts` - 병렬 실행 적용
- `src/utils/constants.ts` - 상수 추가
