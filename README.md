# CompanionBot

> Claude 기반의 개인화된 페르소나를 가진 AI Companion Bot

[![npm version](https://badge.fury.io/js/companionbot.svg)](https://www.npmjs.com/package/companionbot)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## 주요 기능

### 💬 대화
- **자연스러운 대화** - Claude Sonnet/Opus/Haiku 모델 선택 가능
- **페르소나 커스터마이징** - 첫 실행 시 온보딩으로 봇의 성격, 말투, 이름 설정
- **이미지 분석** - 사진을 보내면 분석
- **링크 요약** - URL을 보내면 내용을 읽고 요약

### 🔍 정보 검색 (v0.3.0)
- **웹 검색** - "최신 React 뉴스 검색해줘" (Brave Search API)
- **웹 페이지 읽기** - URL 내용을 가져와서 분석/요약

### ⏰ 일정 관리
- **리마인더** - "10분 뒤에 알려줘"
- **Google Calendar 연동** - 일정 조회/추가/삭제
- **일일 브리핑** - 매일 아침 날씨와 일정 알림
- **Heartbeat** - 주기적으로 체크리스트 확인 후 알림

### 🕐 스케줄링 (v0.3.0)
- **Cron 작업** - "매일 아침 9시에 뉴스 알려줘", "평일 오후 6시에 퇴근 알림"
- **일회성 예약** - "내일 오전 9시에 알려줘"
- **반복 작업** - "30분마다 주식 가격 확인해줘"

### 🤖 고급 기능 (v0.3.0)
- **서브 에이전트** - 복잡한 작업을 백그라운드에서 처리
- **백그라운드 실행** - 긴 명령어를 백그라운드에서 실행하고 결과 확인
- **파일 시스템** - 워크스페이스 내 파일 읽기/쓰기/편집
- **일일 메모리** - 대화 내용 자동 저장

## 설치

### 사전 준비

- **Node.js 18+** ([다운로드](https://nodejs.org))
- **Telegram Bot Token** - [@BotFather](https://t.me/BotFather)에서 봇 생성 후 발급
- **Anthropic API Key** - [console.anthropic.com](https://console.anthropic.com)에서 발급

#### Linux 사용자 (keytar 의존성)

```bash
# Debian/Ubuntu
sudo apt-get install libsecret-1-dev

# Fedora
sudo dnf install libsecret-devel

# Arch
sudo pacman -S libsecret
```

### 간편 설치

```bash
npm install -g companionbot
companionbot
```

### 개발자 설치

```bash
git clone https://github.com/DinN0000/CompanionBot.git
cd companionbot
npm install
npm run build
npm start
```

## 첫 실행

처음 실행하면 대화형 설정이 시작됩니다:

```
🤖 CompanionBot 첫 실행입니다!

[1/2] Telegram Bot Token
      @BotFather에서 봇 생성 후 토큰을 붙여넣으세요.
      Token: _

[2/2] Anthropic API Key
      console.anthropic.com에서 발급받으세요.
      API Key: _

📁 워크스페이스 생성 중...
   → ~/.companionbot/ 생성 완료

🚀 봇을 시작합니다!
```

설정 완료 후 **Telegram에서 봇에게 `/start`를 보내면** 온보딩이 시작됩니다:
- 봇 이름 짓기
- 성격과 말투 설정
- 사용자 정보 입력

## 명령어

### 기본 명령어

| 명령어 | 설명 |
|--------|------|
| `/start` | 봇 시작 (첫 실행 시 온보딩) |
| `/compact` | 대화 정리 (토큰 절약) |
| `/memory` | 최근 일주일 기억 보기 |
| `/model [id]` | AI 모델 변경 (sonnet/opus/haiku) |
| `/reset` | 페르소나 초기화 (온보딩 다시) |

### 기능 설정

| 명령어 | 설명 |
|--------|------|
| `/setup` | 전체 기능 설정 메뉴 |
| `/setup weather` | 날씨 API 설정 |
| `/setup calendar` | Google Calendar 설정 |
| `/setup briefing` | 일일 브리핑 설정 |
| `/setup heartbeat` | Heartbeat 설정 |

### 빠른 명령어

| 명령어 | 설명 |
|--------|------|
| `/briefing` | 일일 브리핑 토글 |
| `/heartbeat` | Heartbeat 토글 |
| `/reminders` | 알림 목록 보기 |
| `/calendar` | 오늘 일정 보기 |

### 자연어 명령

명령어 대신 자연스럽게 말해도 됩니다:

```
모델 변경      "하이쿠로 바꿔줘" / "opus로 변경해줘"
리마인더       "10분 뒤에 알려줘" / "내일 9시에 회의 알림"
브리핑         "브리핑 켜줘" / "지금 브리핑 해줘" / "아침 9시에 브리핑"
Heartbeat     "하트비트 켜줘" / "10분마다 체크해줘"
날씨          "서울 날씨 어때?" / "도쿄 날씨 알려줘"
메모리        "이거 기억해둬"
웹 검색       "React 19 검색해줘" / "최신 뉴스 찾아줘"
Cron          "매일 아침 9시에 뉴스 알려줘" / "평일 오후 6시에 퇴근 알림"
서브에이전트   "이 코드 분석해줘" (복잡한 작업은 자동으로 서브에이전트 사용)
```

## 선택적 기능 설정

### 🌤️ 날씨 (OpenWeatherMap)

1. [openweathermap.org](https://openweathermap.org) 가입
2. API Keys에서 무료 키 발급
3. 봇에게 DM으로: `/weather_setup YOUR_API_KEY`

### 📅 Google Calendar

1. [Google Cloud Console](https://console.cloud.google.com) 접속
2. 프로젝트 생성 → Calendar API 활성화
3. OAuth 동의 화면 설정 (앱 이름, 범위 추가)
4. 사용자 인증 정보 → OAuth 클라이언트 ID (데스크톱 앱)
5. 봇에게 DM으로: `/calendar_setup CLIENT_ID CLIENT_SECRET`
6. 인증 링크 클릭하여 Google 로그인

### 🔍 웹 검색 (Brave Search)

1. [Brave Search API](https://api.search.brave.com) 가입
2. API 키 발급
3. 터미널에서: `npm run setup brave YOUR_API_KEY`

## PM2로 상시 실행

```bash
# PM2 설치
npm install -g pm2

# 봇 시작
pm2 start npm --name companionbot -- start

# 부팅 시 자동 시작
pm2 startup && pm2 save

# 로그 확인
pm2 logs companionbot

# 재시작
pm2 restart companionbot
```

## 워크스페이스

`~/.companionbot/` 구조:

```
├── AGENTS.md      # 운영 지침 (봇 행동 규칙)
├── BOOTSTRAP.md   # 온보딩 프롬프트 (완료 후 삭제됨)
├── HEARTBEAT.md   # 주기적 체크 항목
├── IDENTITY.md    # 봇 정체성 (이름, 이모지, 소개)
├── MEMORY.md      # 장기 기억
├── SOUL.md        # 봇 성격과 말투
├── TOOLS.md       # 도구 설정 노트
├── USER.md        # 사용자 정보
├── canvas/        # 봇 작업 디렉토리
├── cron.json      # 크론 작업 저장
└── memory/        # 일일 로그
    └── YYYY-MM-DD.md
```

### 파일 커스터마이징

- **SOUL.md** - 봇의 성격, 말투, 관심사 수정
- **HEARTBEAT.md** - 주기적으로 체크할 항목 설정
- **AGENTS.md** - 봇의 행동 지침 수정

## 시크릿 저장

API 키는 OS 키체인에 안전하게 저장됩니다:

| OS | 저장 위치 |
|----|-----------|
| macOS | Keychain Access |
| Windows | Credential Manager |
| Linux | libsecret (GNOME Keyring 등) |

완전 초기화: `~/.companionbot/` 폴더 삭제 후 다시 실행

## 트러블슈팅

### 봇이 응답하지 않아요

1. **API 키 확인**: Anthropic API 키가 유효한지 확인
2. **토큰 확인**: Telegram Bot Token이 정확한지 확인
3. **로그 확인**: `pm2 logs companionbot` 또는 터미널 출력 확인

### "rate limit" 오류가 나요

- Anthropic API 사용량 한도 초과
- 잠시 후 다시 시도하거나 API 플랜 업그레이드

### Linux에서 설치 오류

```bash
# keytar 의존성 설치 필요
sudo apt-get install libsecret-1-dev  # Debian/Ubuntu
```

### Google Calendar 인증 실패

1. OAuth 클라이언트 ID가 "데스크톱 앱" 유형인지 확인
2. 리디렉션 URI에 `http://localhost:3847/oauth2callback` 추가
3. `/setup calendar off` 후 `/calendar_setup`으로 다시 시도

### 온보딩이 다시 안 나와요

```bash
# 페르소나 리셋
# Telegram에서: /reset

# 또는 완전 초기화
rm -rf ~/.companionbot
companionbot
```

## 개발

```bash
npm run dev    # 개발 모드 (tsx)
npm run build  # TypeScript 빌드
npm start      # 빌드된 코드 실행
npm test       # 테스트 실행
```

## 버전 히스토리

### v0.3.0 (현재)
- 🔍 웹 검색 (Brave Search API)
- 🕐 Cron 스케줄링 (한국어 지원)
- 🤖 서브 에이전트 (백그라운드 작업)
- 🖥️ 백그라운드 명령어 실행
- 📝 파일 편집 도구 추가

### v0.2.0
- 📅 Google Calendar 연동
- ☀️ 일일 브리핑
- 💓 Heartbeat 시스템
- 🌤️ 날씨 조회

### v0.1.0
- 🚀 초기 릴리스
- 💬 Claude 기반 대화
- 🎭 페르소나 온보딩
- ⏰ 리마인더
- 🖼️ 이미지 분석
- 🔗 링크 요약

## 라이선스

[MIT](LICENSE)

---

**문제가 있거나 기능 요청이 있으면** [Issues](https://github.com/DinN0000/CompanionBot/issues)에 등록해주세요!
