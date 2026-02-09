import * as fs from "fs/promises";
import * as path from "path";
import { getWorkspacePath, getWorkspaceFilePath, getDailyMemoryPath } from "./paths.js";

// 파일 크기 제한 (문자 수)
const FILE_LIMITS = {
  identity: 2000,    // IDENTITY.md - 간결해야 함
  soul: 4000,        // SOUL.md - 성격/스타일
  user: 3000,        // USER.md - 사용자 정보
  agents: 8000,      // AGENTS.md - 가이드라인
  tools: 3000,       // TOOLS.md - 도구 노트
  heartbeat: 2000,   // HEARTBEAT.md - 체크리스트
  memory: 6000,      // MEMORY.md - 장기 기억
  bootstrap: 2000,   // BOOTSTRAP.md - 온보딩
} as const;

// 전체 워크스페이스 최대 크기 (토큰 절약)
const TOTAL_WORKSPACE_LIMIT = 25000;

export interface Workspace {
  agents: string | null;
  bootstrap: string | null;
  identity: string | null;
  soul: string | null;
  user: string | null;
  tools: string | null;
  heartbeat: string | null;
  memory: string | null;
  /** 오늘/어제 daily memory (최근 대화 컨텍스트) */
  recentDaily: string | null;
  /** 크기 제한으로 잘린 파일 목록 */
  truncated: string[];
}

/**
 * 파일을 읽고 크기 제한 적용
 */
async function readFileWithLimit(
  filePath: string,
  limit: number
): Promise<{ content: string | null; truncated: boolean }> {
  try {
    const content = await fs.readFile(filePath, "utf-8");
    if (content.length > limit) {
      // 마지막 완전한 문단에서 자르기
      let truncated = content.slice(0, limit);
      const lastNewline = truncated.lastIndexOf("\n\n");
      if (lastNewline > limit * 0.7) {
        truncated = truncated.slice(0, lastNewline);
      }
      return { 
        content: truncated + "\n\n... (truncated)", 
        truncated: true 
      };
    }
    return { content, truncated: false };
  } catch {
    return { content: null, truncated: false };
  }
}

async function readFileOrNull(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf-8");
  } catch {
    return null;
  }
}

/**
 * 오늘과 어제의 daily memory를 로드합니다.
 * 시스템 프롬프트에 직접 포함되어 최근 컨텍스트를 제공합니다.
 */
async function loadRecentDailyMemory(): Promise<string | null> {
  const parts: string[] = [];
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);

  const DAILY_LIMIT = 2500; // 각 날짜별 최대 문자 수

  for (const [label, date] of [["오늘", today], ["어제", yesterday]] as const) {
    try {
      const memoryPath = getDailyMemoryPath(date as Date);
      let content = await fs.readFile(memoryPath, "utf-8");
      
      if (content.trim()) {
        // 너무 길면 최근 부분만 유지 (## 타임스탬프 기준)
        if (content.length > DAILY_LIMIT) {
          // ## 로 시작하는 섹션들로 분할
          const sections = content.split(/(?=^## )/m);
          let trimmedContent = "";
          
          // 뒤에서부터 추가 (최근 기록 우선)
          for (let i = sections.length - 1; i >= 0; i--) {
            if ((trimmedContent + sections[i]).length > DAILY_LIMIT) break;
            trimmedContent = sections[i] + trimmedContent;
          }
          
          content = "...(이전 기록 생략)...\n" + trimmedContent.trim();
        }
        
        parts.push(`### ${label} 기록 (${(date as Date).toISOString().split("T")[0]})\n${content.trim()}`);
      }
    } catch {
      // 파일 없음 무시
    }
  }

  return parts.length > 0 ? parts.join("\n\n") : null;
}

export async function loadWorkspace(): Promise<Workspace> {
  const workspacePath = getWorkspacePath();
  const truncatedFiles: string[] = [];

  const results = await Promise.all([
    readFileWithLimit(path.join(workspacePath, "AGENTS.md"), FILE_LIMITS.agents),
    readFileOrNull(path.join(workspacePath, "BOOTSTRAP.md")), // bootstrap은 제한 없음 (임시)
    readFileWithLimit(path.join(workspacePath, "IDENTITY.md"), FILE_LIMITS.identity),
    readFileWithLimit(path.join(workspacePath, "SOUL.md"), FILE_LIMITS.soul),
    readFileWithLimit(path.join(workspacePath, "USER.md"), FILE_LIMITS.user),
    readFileWithLimit(path.join(workspacePath, "TOOLS.md"), FILE_LIMITS.tools),
    readFileWithLimit(path.join(workspacePath, "HEARTBEAT.md"), FILE_LIMITS.heartbeat),
    readFileWithLimit(path.join(workspacePath, "MEMORY.md"), FILE_LIMITS.memory),
    loadRecentDailyMemory(), // 오늘/어제 daily memory
  ]);

  const [agents, bootstrap, identity, soul, user, tools, heartbeat, memory, recentDaily] = results;

  // 잘린 파일 추적
  const fileNames = ["AGENTS.md", "BOOTSTRAP.md", "IDENTITY.md", "SOUL.md", "USER.md", "TOOLS.md", "HEARTBEAT.md", "MEMORY.md"];
  results.slice(0, 8).forEach((r, i) => {
    if (typeof r === "object" && r !== null && "truncated" in r && r.truncated) {
      truncatedFiles.push(fileNames[i]);
    }
  });

  // 타입 가드: readFileWithLimit 결과에서 content 추출
  const getContent = (r: unknown): string | null => {
    if (r && typeof r === "object" && "content" in r) {
      return (r as { content: string | null }).content;
    }
    return null;
  };

  return {
    agents: getContent(agents),
    bootstrap: typeof bootstrap === "string" ? bootstrap : null,
    identity: getContent(identity),
    soul: getContent(soul),
    user: getContent(user),
    tools: getContent(tools),
    heartbeat: getContent(heartbeat),
    memory: getContent(memory),
    recentDaily: typeof recentDaily === "string" ? recentDaily : null,
    truncated: truncatedFiles,
  };
}

export async function loadBootstrap(): Promise<string | null> {
  return readFileOrNull(getWorkspaceFilePath("BOOTSTRAP.md"));
}

export async function saveWorkspaceFile(
  filename: string,
  content: string
): Promise<void> {
  const filePath = getWorkspaceFilePath(filename);
  await fs.writeFile(filePath, content, "utf-8");
}

export async function appendToMemory(content: string): Promise<void> {
  const memoryPath = getDailyMemoryPath();
  const timestamp = new Date().toLocaleTimeString("ko-KR", { hour12: false });
  const entry = `\n## ${timestamp}\n${content}\n`;

  try {
    await fs.appendFile(memoryPath, entry, "utf-8");
  } catch {
    // 파일이 없으면 헤더와 함께 생성
    const date = new Date().toLocaleDateString("ko-KR");
    const header = `# ${date} 기억\n`;
    await fs.writeFile(memoryPath, header + entry, "utf-8");
  }
}

export async function loadRecentMemories(days: number = 7): Promise<string> {
  const memories: string[] = [];
  const today = new Date();

  for (let i = 0; i < days; i++) {
    const date = new Date(today);
    date.setDate(date.getDate() - i);
    const memoryPath = getDailyMemoryPath(date);

    const content = await readFileOrNull(memoryPath);
    if (content) {
      memories.push(content);
    }
  }

  return memories.join("\n\n---\n\n");
}
