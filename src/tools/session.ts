/**
 * Session management for background commands
 * OpenClaw 스타일 보안 모델
 */

import { spawn, ChildProcess } from "child_process";
import { randomUUID } from "crypto";
import { promisify } from "util";
import { exec } from "child_process";
import {
  SESSION_MAX_OUTPUT_LINES,
  SESSION_CLEANUP_INTERVAL_MS,
  SESSION_TTL_MS,
} from "../utils/constants.js";
import { getWorkspacePath } from "../workspace/index.js";
import { isPathAllowed } from "./pathCheck.js";
import * as path from "path";
import * as fs from "fs";

const execAsync = promisify(exec);

// ============== 세션 관리 ==============
export interface ProcessSession {
  id: string;
  pid: number;
  command: string;
  cwd: string;
  startTime: Date;
  endTime?: Date;
  exitCode?: number | null;
  outputBuffer: string[];
  process: ChildProcess;
  status: "running" | "completed" | "killed" | "error";
}

// 메모리에 세션 저장
const sessions = new Map<string, ProcessSession>();

// 완료된 세션 자동 정리 함수
function cleanupStaleSessions(): void {
  const now = Date.now();
  for (const [id, session] of sessions) {
    // 완료/에러/종료된 세션만 정리
    if (session.status !== "running" && session.endTime) {
      const age = now - session.endTime.getTime();
      if (age > SESSION_TTL_MS) {
        sessions.delete(id);
      }
    }
  }
}

// 주기적 세션 정리 시작
setInterval(cleanupStaleSessions, SESSION_CLEANUP_INTERVAL_MS);

function appendOutput(session: ProcessSession, data: string) {
  const lines = data.split("\n");
  session.outputBuffer.push(...lines);
  // 버퍼 크기 제한
  if (session.outputBuffer.length > SESSION_MAX_OUTPUT_LINES) {
    session.outputBuffer = session.outputBuffer.slice(-SESSION_MAX_OUTPUT_LINES);
  }
}

// ============== OpenClaw 스타일 보안 ==============

// 허용된 명령어 (basename)
const ALLOWED_COMMANDS = new Set([
  // 기본 유틸
  "ls", "pwd", "cat", "head", "tail", "grep", "find", "wc",
  "sort", "uniq", "diff", "echo", "date", "which", "env", "printenv",
  // 개발 도구
  "git", "npm", "npx", "node", "pnpm", "yarn", "bun",
  // 텍스트 처리
  "sed", "awk", "cut", "tr", "jq",
]);

// stdin-only로 안전하게 사용 가능한 명령 (OpenClaw safeBins)
const SAFE_BINS = new Set([
  "jq", "grep", "cut", "sort", "uniq", "head", "tail", "tr", "wc",
]);

// OpenClaw 스타일 파이프라인 토큰 차단
const DISALLOWED_PIPELINE_TOKENS = [
  ">",   // 리디렉션
  "<",   // 입력 리디렉션
  "`",   // 명령 치환
  "\n",  // 줄바꿈
  "\r",  // 캐리지 리턴
  "(",   // 서브셸
  ")",
  "$(",  // 명령 치환
  "${",  // 변수 확장
];

// 위험한 인자
const DANGEROUS_ARGS = new Set([
  "--force", "-rf", "--hard", "--no-preserve-root",
  "-f", "--delete", "--remove",
]);

// 위험한 명령어 (절대 허용 안 함)
const BLOCKED_COMMANDS = new Set([
  "rm", "rmdir", "mv", "cp", "chmod", "chown", "chgrp",
  "sudo", "su", "dd", "mkfs", "fdisk", "mount", "umount",
  "kill", "killall", "pkill", "shutdown", "reboot", "halt",
  "curl", "wget", // 네트워크 명령은 web_fetch로 대체
]);

// 안전한 환경 변수
function getSafeEnv(): Record<string, string> {
  return {
    PATH: process.env.PATH || "",
    HOME: process.env.HOME || "",
    USER: process.env.USER || "",
    LANG: process.env.LANG || "en_US.UTF-8",
    TERM: process.env.TERM || "xterm",
  };
}

// 명령어에서 basename 추출
function extractCommandName(command: string): string | null {
  const trimmed = command.trim();
  const firstPart = trimmed.split(/\s+/)[0];
  if (!firstPart) return null;
  return path.basename(firstPart);
}

// 파이프라인 토큰 체크
function containsDisallowedTokens(command: string): boolean {
  return DISALLOWED_PIPELINE_TOKENS.some(token => command.includes(token));
}

// 체이닝 분리 (&&, ||, ;)
function splitChainedCommands(command: string): string[] {
  // 간단한 분리 (따옴표 내부는 무시 - 완벽하진 않지만 기본적인 케이스 커버)
  return command.split(/\s*(?:&&|\|\||;)\s*/);
}

// 명령어 검증
function validateCommand(command: string): { valid: boolean; error?: string } {
  // 1. 위험한 토큰 차단
  if (containsDisallowedTokens(command)) {
    return { valid: false, error: "리디렉션, 치환, 서브셸은 사용할 수 없어" };
  }

  // 2. 체이닝된 각 명령어 검증
  const commands = splitChainedCommands(command);
  
  for (const cmd of commands) {
    const cmdName = extractCommandName(cmd);
    if (!cmdName) continue;

    // 3. 블록된 명령어 체크
    if (BLOCKED_COMMANDS.has(cmdName)) {
      return { valid: false, error: `'${cmdName}'은 보안상 차단된 명령어야` };
    }

    // 4. 허용된 명령어 체크
    if (!ALLOWED_COMMANDS.has(cmdName)) {
      return { 
        valid: false, 
        error: `'${cmdName}'은 허용 목록에 없어. 허용: ${[...ALLOWED_COMMANDS].slice(0, 10).join(", ")}...` 
      };
    }

    // 5. 위험한 인자 체크
    const args = cmd.trim().split(/\s+/).slice(1);
    for (const arg of args) {
      if (DANGEROUS_ARGS.has(arg)) {
        return { valid: false, error: `위험한 인자 '${arg}'는 사용할 수 없어` };
      }
    }
  }

  return { valid: true };
}

// cwd 검증 (workspace 내로 제한)
function validateCwd(cwd: string): { valid: boolean; resolvedCwd: string; error?: string } {
  const workspace = getWorkspacePath();
  const resolved = path.resolve(cwd);

  // workspace 또는 /tmp 내에 있어야 함
  if (!isPathAllowed(resolved)) {
    return { 
      valid: false, 
      resolvedCwd: workspace,
      error: `작업 디렉토리는 workspace (${workspace}) 또는 /tmp 내에 있어야 해` 
    };
  }

  // 디렉토리 존재 확인
  try {
    const stat = fs.statSync(resolved);
    if (!stat.isDirectory()) {
      return { valid: false, resolvedCwd: workspace, error: `'${cwd}'는 디렉토리가 아니야` };
    }
    return { valid: true, resolvedCwd: resolved };
  } catch {
    return { valid: false, resolvedCwd: workspace, error: `'${cwd}' 디렉토리를 찾을 수 없어` };
  }
}

// run_command 실행
export async function executeRunCommand(input: Record<string, unknown>): Promise<string> {
  const command = input.command as string;
  const requestedCwd = (input.cwd as string) || getWorkspacePath();
  const background = (input.background as boolean) || false;
  const timeout = ((input.timeout as number) || 30) * 1000;

  // 1. 명령어 검증
  const cmdValidation = validateCommand(command);
  if (!cmdValidation.valid) {
    return `Error: ${cmdValidation.error}`;
  }

  // 2. cwd 검증
  const cwdValidation = validateCwd(requestedCwd);
  if (!cwdValidation.valid) {
    return `Error: ${cwdValidation.error}`;
  }
  const cwd = cwdValidation.resolvedCwd;

  const safeEnv = getSafeEnv();

  // Background 실행
  if (background) {
    const sessionId = randomUUID().slice(0, 8);
    
    const child = spawn("sh", ["-c", command], {
      cwd,
      env: safeEnv,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const session: ProcessSession = {
      id: sessionId,
      pid: child.pid!,
      command,
      cwd,
      startTime: new Date(),
      outputBuffer: [],
      process: child,
      status: "running",
    };

    // stdout/stderr 캡처
    child.stdout?.on("data", (data: Buffer) => {
      appendOutput(session, data.toString());
    });
    child.stderr?.on("data", (data: Buffer) => {
      appendOutput(session, `[stderr] ${data.toString()}`);
    });

    // 프로세스 종료 핸들링
    child.on("close", (code) => {
      session.endTime = new Date();
      session.exitCode = code;
      session.status = code === 0 ? "completed" : "error";
    });

    child.on("error", (err) => {
      session.status = "error";
      appendOutput(session, `[error] ${err.message}`);
    });

    // unref로 부모 프로세스와 분리
    child.unref();

    sessions.set(sessionId, session);

    return `백그라운드 세션 시작됨
Session ID: ${sessionId}
PID: ${child.pid}
Command: ${command}
CWD: ${cwd}

manage_session으로 세션 관리 가능 (list/log/kill)`;
  }

  // Foreground 실행 (기존 방식)
  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd,
      timeout,
      env: safeEnv,
    });
    return stdout || stderr || "명령 실행 완료 (출력 없음)";
  } catch (error) {
    return `Error: ${error instanceof Error ? error.message : String(error)}`;
  }
}

// list_sessions 실행
export function executeListSessions(input: Record<string, unknown>): string {
  const statusFilter = (input.status as string) || "all";
  
  const sessionList: string[] = [];
  
  for (const [id, session] of sessions) {
    // 상태 필터링
    if (statusFilter !== "all") {
      if (statusFilter === "running" && session.status !== "running") continue;
      if (statusFilter === "completed" && session.status === "running") continue;
    }

    const runtime = session.endTime 
      ? `${Math.round((session.endTime.getTime() - session.startTime.getTime()) / 1000)}s`
      : `${Math.round((Date.now() - session.startTime.getTime()) / 1000)}s (실행 중)`;

    const status = session.status === "running" 
      ? "🟢 실행 중" 
      : session.status === "completed" 
        ? "✅ 완료" 
        : session.status === "killed"
          ? "🔴 종료됨"
          : "❌ 에러";

    sessionList.push(`[${id}] ${status}
  Command: ${session.command}
  PID: ${session.pid}
  Runtime: ${runtime}
  Exit code: ${session.exitCode ?? "N/A"}`);
  }

  if (sessionList.length === 0) {
    return `세션 없음${statusFilter !== "all" ? ` (필터: "${statusFilter}")` : ""}`;
  }

  return `세션 목록 (${sessionList.length}개):\n\n${sessionList.join("\n\n")}`;
}

// get_session_log 실행
export function executeGetSessionLog(input: Record<string, unknown>): string {
  const sessionId = input.session_id as string;
  const tail = (input.tail as number) || 50;

  const session = sessions.get(sessionId);
  if (!session) {
    return `Error: 세션 "${sessionId}"을 찾을 수 없어. list_sessions로 확인해봐.`;
  }

  const lines = session.outputBuffer.slice(-tail);
  
  if (lines.length === 0) {
    return `세션 ${sessionId} 출력 없음
상태: ${session.status}
명령어: ${session.command}`;
  }

  const header = `세션: ${sessionId} (${session.status})
명령어: ${session.command}
마지막 ${lines.length}줄:
${"─".repeat(40)}`;

  return `${header}\n${lines.join("\n")}`;
}

// kill_session 실행
export function executeKillSession(input: Record<string, unknown>): string {
  const sessionId = input.session_id as string;
  const signal = (input.signal as NodeJS.Signals) || "SIGTERM";

  const session = sessions.get(sessionId);
  if (!session) {
    return `Error: 세션 "${sessionId}"을 찾을 수 없어.`;
  }

  if (session.status !== "running") {
    return `세션 ${sessionId}은 이미 실행 중이 아니야 (상태: ${session.status})`;
  }

  try {
    // Process group kill (negative PID)
    process.kill(-session.pid, signal);
    session.status = "killed";
    session.endTime = new Date();
    return `세션 ${sessionId} (PID ${session.pid}) ${signal}로 종료됨`;
  } catch (error) {
    // 단일 프로세스 kill 시도
    try {
      session.process.kill(signal);
      session.status = "killed";
      session.endTime = new Date();
      return `세션 ${sessionId} ${signal}로 종료됨`;
    } catch (e) {
      return `Error: 세션 종료 실패 - ${error instanceof Error ? error.message : String(error)}`;
    }
  }
}
