# Claude Code Guide

이 문서는 Claude Code가 CompanionBot 프로젝트를 이해하고 도울 수 있도록 작성되었습니다.

## 프로젝트 개요

CompanionBot은 Telegram에서 동작하는 AI 친구 봇입니다. Claude API를 사용하여 개인화된 대화를 제공합니다.

**버전:** 0.6.0

## 핵심 아키텍처

```
사용자 (Telegram)
    ↓
grammY (Telegram Bot Framework) + Rate Limiter
    ↓
bot.ts (메시지 핸들러)
    ↓
claude.ts (Claude API + Tool Use)
    ↓
├── tools/        (40+ 도구들)
├── agents/       (Sub-agent 시스템)
├── cron/         (스케줄링)
├── workspace/    (페르소나 & 메모리)
└── ...
```

## 설치

```bash
npm install -g companionbot
companionbot
```

첫 실행 시 CLI가 자동으로:
- Telegram Bot Token 입력 요청
- Anthropic API Key 입력 요청
- `~/.companionbot/` 워크스페이스 생성
- 봇 시작

### PM2로 백그라운드 실행 (권장)
```bash
npm install -g pm2
pm2 start companionbot --name companionbot
pm2 startup && pm2 save
```

## 워크스페이스 구조

`~/.companionbot/`:
```
├── AGENTS.md       # 운영 지침
├── BOOTSTRAP.md    # 온보딩 (완료 후 삭제됨)
├── HEARTBEAT.md    # 주기적 체크 항목
├── IDENTITY.md     # 이름, 이모지, 바이브
├── MEMORY.md       # 장기 기억
├── SOUL.md         # 성격, 말투
├── TOOLS.md        # 도구 설정 (확장용)
├── USER.md         # 사용자 정보
├── cron-jobs.json  # Cron 스케줄
├── canvas/         # 봇 작업 디렉토리
└── memory/         # 일일 로그
    └── YYYY-MM-DD.md
```

## 주요 모듈

### src/telegram/
- `bot.ts`: 봇 초기화, rate limiting, cron/agent 시작
- `handlers/commands.ts`: 명령어 핸들러
- `handlers/messages.ts`: 텍스트/이미지 처리
- `utils/`: 캐싱, 프롬프트, URL 처리

### src/tools/index.ts
**40+ 도구** 포함:
- **파일**: read_file, write_file, edit_file, list_directory
- **명령어**: run_command (background 지원), list_sessions, get_session_log, kill_session
- **웹**: web_search (Brave API), web_fetch
- **AI 관련**: change_model, save_memory, save_persona
- **일정**: get_calendar_events, add_calendar_event, delete_calendar_event
- **리마인더**: set_reminder, list_reminders, cancel_reminder
- **날씨**: get_weather
- **스케줄링**: add_cron, list_crons, remove_cron, toggle_cron, run_cron
- **Sub-agent**: spawn_agent, list_agents, cancel_agent
- **브리핑/Heartbeat**: control_briefing, control_heartbeat, etc.

### src/agents/
Sub-agent 시스템:
- `types.ts`: Agent 인터페이스
- `manager.ts`: AgentManager - spawn, cancel, cleanup
- 백그라운드에서 독립적인 Claude API 호출
- AbortController로 취소 지원

### src/cron/
Cron 스케줄링:
- `types.ts`: Schedule, Payload, CronJob 타입
- `parser.ts`: cron expression 파서 + 한국어 지원
- `scheduler.ts`: 스케줄러 엔진
- `store.ts`: JSON 파일 저장 (파일 락 지원)
- Timezone 지원 (Intl API)

### src/session/state.ts
- `AsyncLocalStorage`로 chatId 관리 (race condition 방지)
- `runWithChatId()`: 컨텍스트 주입
- `getCurrentChatId()`: 현재 chatId 조회

### src/memory/ (v0.6.0)
시맨틱 메모리 검색:
- `embeddings.ts`: 텍스트 임베딩 생성 (Xenova/Transformers)
- `vectorStore.ts`: 벡터 저장 및 유사도 검색
- `indexer.ts`: 메모리 파일 자동 인덱싱

### src/health/ (v0.6.0)
봇 상태 모니터링:
- `recordActivity()`: 메시지 처리 기록
- `getHealthStatus()`: uptime, 메시지/오류 수, 건강 상태

### src/updates/ (v0.6.0)
자동 업데이트 체크:
- `checkForUpdates()`: npm 레지스트리에서 최신 버전 확인
- `getCurrentVersion()`: 현재 설치된 버전

### src/config/secrets.ts
OS 키체인에 시크릿 저장 (keytar):
- `telegram-token`
- `anthropic-api-key`
- `openweathermap-api-key`
- `brave-api-key`
- Google Calendar credentials

## 명령어

| 명령어 | 동작 |
|--------|------|
| `/start` | 시작/온보딩 |
| `/reset` | 페르소나 초기화 (토큰 인증 필요) |
| `/compact` | 히스토리 압축 |
| `/memory` | 메모리 보기 |
| `/model [name]` | 모델 변경 (sonnet/opus/haiku) |
| `/setup` | 기능 설정 메뉴 |
| `/reminders` | 알림 목록 |
| `/calendar` | 오늘 일정 |
| `/briefing` | 토글 |
| `/heartbeat` | 토글 |

## 보안 고려사항

### 파일 시스템
- `isPathAllowed()`: 허용 경로만 접근 가능
- `DANGEROUS_PATTERNS`: .ssh, .env 등 차단
- TOCTOU 위험성 문서화됨

### 명령어 실행
- 화이트리스트 방식 (git, npm, ls 등)
- 명령어 체이닝 차단 (;, &&, |, \n, >, < 등)
- 환경변수 sanitization

### 네트워크
- SSRF 방지: 사설 IP 차단 (127.x, 10.x, 172.16-31.x, 192.168.x, ::1 등)
- Rate limiting: 1분에 10개 메시지

### API 키
- DM에서만 설정 가능
- 메시지 자동 삭제
- OS 키체인 저장

## 기능 추가 가이드

### 1. 새 도구 추가
```typescript
// src/tools/index.ts

// 1. tools 배열에 추가
{
  name: "my_tool",
  description: "도구 설명",
  input_schema: { ... }
}

// 2. executeTool()에 case 추가
case "my_tool": {
  const chatId = getCurrentChatId();
  // 실행 로직
  return "결과";
}

// 3. getToolsDescription()에 설명 추가
```

### 2. 새 명령어 추가
```typescript
// src/telegram/handlers/commands.ts
bot.command("mycommand", async (ctx) => {
  // 핸들러 로직
});
```

### 3. Cron Job 타입 추가
```typescript
// src/cron/types.ts
interface MyPayload {
  kind: "myPayload";
  // ...
}
```

## 테스트

```bash
npm test           # vitest 실행
npm run test:watch # 감시 모드
```

테스트 파일:
- `tests/tools/isPathAllowed.test.ts`: 보안 크리티컬
- `tests/cron/parser.test.ts`: cron 파싱

## 트러블슈팅

### "Conflict: terminated by other getUpdates request"
```bash
pm2 stop companionbot  # 또는
pkill -f companionbot
```

### 시크릿 재설정
```bash
rm -rf ~/.companionbot
companionbot
```

### 빌드 에러
```bash
rm -rf node_modules dist
npm install
npm run build
```

### Rate limit 오류
Claude API rate limit 발생 시 잠시 대기 후 재시도

## 버전 히스토리

- **v0.1.x**: 초기 릴리즈, 하드코딩 경로 수정
- **v0.2.x**: 백그라운드 실행, sub-agent, web_search/fetch, edit_file
- **v0.3.x**: Cron 스케줄링 시스템
- **v0.4.x**: 보안 강화 (TOCTOU, 심볼릭 링크 검증), 환경변수 설정
- **v0.5.x**: 보안 강화 (SSRF 방지), 테스트 추가 (vitest)
- **v0.6.x**: 시맨틱 메모리 검색 (임베딩/벡터), 헬스 체크, 업데이트 알림
