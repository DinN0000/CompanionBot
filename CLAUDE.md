# Claude Code Guide

이 문서는 Claude Code가 CompanionBot 프로젝트를 이해하고 도울 수 있도록 작성되었습니다.

## 프로젝트 개요

CompanionBot은 Telegram에서 동작하는 AI 친구 봇입니다. Claude API를 사용하여 개인화된 대화를 제공합니다.

## 핵심 아키텍처

```
사용자 (Telegram)
    ↓
grammY (Telegram Bot Framework)
    ↓
bot.ts (메시지 핸들러)
    ↓
claude.ts (Claude API + Tool Use)
    ↓
workspace/ (페르소나 & 메모리)
```

## 설치

```bash
npm install
npm run build
npm start
```

첫 실행 시 CLI가 자동으로:
- Telegram Bot Token 입력 요청
- Anthropic API Key 입력 요청
- `~/.companionbot/` 워크스페이스 생성
- 봇 시작

### PM2로 백그라운드 실행 (선택)
```bash
npm install -g pm2
pm2 start npm --name companionbot -- start
pm2 startup && pm2 save
```

## 워크스페이스 구조

`~/.companionbot/`:
```
├── AGENTS.md      # 운영 지침
├── BOOTSTRAP.md   # 온보딩 (완료 후 삭제됨)
├── HEARTBEAT.md   # 주기적 체크 항목
├── IDENTITY.md    # 이름, 이모지, 바이브
├── MEMORY.md      # 장기 기억
├── SOUL.md        # 성격, 말투
├── TOOLS.md       # 도구 설정 (확장용)
├── USER.md        # 사용자 정보
├── canvas/        # 봇 작업 디렉토리
└── memory/        # 일일 로그
    └── YYYY-MM-DD.md
```

## 주요 모듈

### src/telegram/bot.ts
- Telegram 메시지 핸들러
- 명령어는 토글 방식 (간단하게)
- 상세 설정은 자연어로

### src/tools/index.ts
도구 추가 시:
1. `tools` 배열에 정의 추가
2. `executeTool()` 함수에 실행 로직 추가
3. `getToolsDescription()`에 설명 추가

### src/workspace/
- `paths.ts`: 경로 상수
- `init.ts`: 워크스페이스 초기화
- `load.ts`: 파일 읽기/쓰기

### src/config/secrets.ts
OS 키체인에 시크릿 저장 (keytar):
- `telegram-token`
- `anthropic-api-key`
- `openweathermap-api-key`

## 명령어 (토글 방식)

| 명령어 | 동작 |
|--------|------|
| `/start` | 시작/온보딩 |
| `/reset` | 대화 리셋 |
| `/compact` | 히스토리 압축 |
| `/memory` | 메모리 보기 |
| `/setup` | 기능 설정 메뉴 |
| `/reminders` | 알림 목록 |
| `/calendar` | 오늘 일정 |
| `/briefing` | 토글 (상세는 자연어) |
| `/heartbeat` | 토글 (상세는 자연어) |

## 기능 모듈

### src/briefing/
일일 브리핑 - 매일 아침 날씨/일정 알림
- `setBriefingConfig()`, `sendBriefingNow()`
- node-cron으로 스케줄링

### src/heartbeat/
주기적 체크 - HEARTBEAT.md 기반으로 알릴 게 있으면 메시지
- `setHeartbeatConfig()`, `runHeartbeatNow()`
- setInterval로 스케줄링

### src/reminders/
리마인더 - 자연어로 설정 ("10분 뒤에 알려줘")
- `createReminder()`, `getReminders()`

### src/calendar/
Google Calendar 연동
- OAuth 인증 필요 (`/calendar_setup`)
- `getTodayEvents()`, `addEvent()`

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
  // 실행 로직
  return "결과";
}

// 3. getToolsDescription()에 설명 추가
```

### 2. 새 명령어 추가 (토글 방식)
```typescript
// src/telegram/bot.ts
bot.command("mycommand", async (ctx) => {
  // 상태 확인 후 토글
  if (!enabled) {
    // 켜기
  } else {
    // 상태 표시
  }
});
```

### 3. 새 모듈 추가
1. `src/mymodule/index.ts` 생성
2. 필요하면 `templates/MYMODULE.md` 생성
3. `src/workspace/paths.ts`의 `WORKSPACE_FILES`에 추가
4. `bot.ts`에서 import 및 초기화

### 4. 워크스페이스 파일 추가
1. `templates/`에 템플릿 파일 생성
2. `src/workspace/paths.ts`의 `WORKSPACE_FILES`에 추가
3. 기존 사용자는 수동 복사 필요 (또는 마이그레이션 스크립트)

## 설계 원칙

1. **명령어는 심플하게** - 토글만, 상세 설정은 자연어로
2. **도구로 자연어 처리** - 사용자가 말하면 AI가 도구 호출
3. **워크스페이스 기반** - 설정은 ~/.companionbot/에 파일로
4. **확장 가능** - TOOLS.md, canvas/는 미래 확장용

## 트러블슈팅

### "Conflict: terminated by other getUpdates request"
```bash
pm2 stop companionbot  # 또는
pkill -f "tsx src/cli"
```

### 시크릿 재설정
```bash
rm -rf ~/.companionbot
npm start
```

### 빌드 에러
```bash
rm -rf node_modules dist
npm install
npm run build
```
