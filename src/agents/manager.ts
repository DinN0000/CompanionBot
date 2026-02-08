/**
 * AgentManager - Sub-agent 생성 및 관리
 * 
 * 각 sub-agent는:
 * - 별도의 Claude API 호출로 독립 실행
 * - 메인 conversation과 별개의 context
 * - 비동기로 실행, 완료 시 callback
 */

import Anthropic from "@anthropic-ai/sdk";
import { randomUUID } from "crypto";
import type { Bot } from "grammy";
import { Agent, AgentStatus, AgentResult } from "./types.js";

// Agent 저장소
const agents = new Map<string, Agent>();

// AbortController 저장소 (실행 중인 API 호출 취소용)
const abortControllers = new Map<string, AbortController>();

// Bot 인스턴스 (결과 전송용)
let botInstance: Bot | null = null;

// Anthropic 클라이언트
let anthropic: Anthropic | null = null;

function getClient(): Anthropic {
  if (!anthropic) {
    anthropic = new Anthropic();
  }
  return anthropic;
}

/**
 * Bot 인스턴스 설정 (시작 시 호출)
 */
export function setAgentBot(bot: Bot): void {
  botInstance = bot;
}

/**
 * Sub-agent 생성 및 실행
 */
export async function spawnAgent(
  task: string,
  chatId: number
): Promise<string> {
  const id = randomUUID().slice(0, 8);
  
  const agent: Agent = {
    id,
    task,
    status: "running",
    chatId,
    createdAt: new Date(),
  };
  
  agents.set(id, agent);
  
  // 비동기로 agent 실행 (await 하지 않음)
  runAgent(agent).catch((err) => {
    console.error(`[Agent ${id}] Error:`, err);
  });
  
  return id;
}

/**
 * Agent 실행 (내부 함수)
 */
async function runAgent(agent: Agent): Promise<void> {
  const client = getClient();
  
  // AbortController 생성 및 저장
  const controller = new AbortController();
  abortControllers.set(agent.id, controller);
  
  const systemPrompt = `You are a sub-agent assistant. Your job is to complete a specific task and report the result concisely.

TASK: ${agent.task}

Guidelines:
- Focus only on the given task
- Be concise but thorough
- Report results clearly
- If you cannot complete the task, explain why

Complete the task and provide your final answer.`;

  try {
    console.log(`[Agent ${agent.id}] Starting: ${agent.task.slice(0, 50)}...`);
    
    const response = await client.messages.create(
      {
        model: "claude-sonnet-4-20250514",
        max_tokens: 2048,
        system: systemPrompt,
        messages: [
          {
            role: "user",
            content: `Please complete this task: ${agent.task}`,
          },
        ],
      },
      {
        signal: controller.signal,
      }
    );

    // 취소됐으면 결과 무시
    if (agent.status === "cancelled") {
      console.log(`[Agent ${agent.id}] Was cancelled, ignoring result`);
      return;
    }

    // 결과 추출
    const textBlock = response.content.find(
      (block): block is Anthropic.TextBlock => block.type === "text"
    );
    
    const result = textBlock?.text ?? "No response generated.";
    
    // Agent 상태 업데이트
    agent.status = "completed";
    agent.completedAt = new Date();
    agent.result = result;
    
    console.log(`[Agent ${agent.id}] Completed`);
    
    // 결과를 원래 chat에 전송
    await sendAgentResult(agent);
    
  } catch (error) {
    // 취소로 인한 abort는 무시
    if (agent.status === "cancelled") {
      console.log(`[Agent ${agent.id}] Aborted due to cancellation`);
      return;
    }
    
    agent.status = "failed";
    agent.completedAt = new Date();
    agent.error = error instanceof Error ? error.message : String(error);
    
    console.error(`[Agent ${agent.id}] Failed:`, agent.error);
    
    // 실패도 알림
    await sendAgentResult(agent);
  } finally {
    // Controller 정리
    abortControllers.delete(agent.id);
  }
}

/**
 * Agent 결과를 chat에 전송
 */
async function sendAgentResult(agent: Agent): Promise<void> {
  if (!botInstance) {
    console.warn("[Agent] No bot instance, cannot send result");
    return;
  }
  
  let message: string;
  
  if (agent.status === "completed") {
    message = `🤖 **Sub-agent 완료** (${agent.id})\n\n📋 Task: ${agent.task.slice(0, 100)}${agent.task.length > 100 ? "..." : ""}\n\n✅ Result:\n${agent.result}`;
  } else if (agent.status === "failed") {
    message = `🤖 **Sub-agent 실패** (${agent.id})\n\n📋 Task: ${agent.task.slice(0, 100)}${agent.task.length > 100 ? "..." : ""}\n\n❌ Error: ${agent.error}`;
  } else if (agent.status === "cancelled") {
    message = `🤖 **Sub-agent 취소됨** (${agent.id})`;
  } else {
    return; // running 상태면 전송 안 함
  }
  
  try {
    await botInstance.api.sendMessage(agent.chatId, message);
  } catch (err) {
    console.error(`[Agent ${agent.id}] Failed to send result:`, err);
  }
}

/**
 * Agent 목록 조회
 */
export function listAgents(chatId?: number): Agent[] {
  const allAgents = Array.from(agents.values());
  
  if (chatId !== undefined) {
    return allAgents.filter((a) => a.chatId === chatId);
  }
  
  return allAgents;
}

/**
 * Agent 취소
 */
export function cancelAgent(agentId: string): boolean {
  const agent = agents.get(agentId);
  
  if (!agent) {
    return false;
  }
  
  if (agent.status !== "running") {
    return false; // 이미 완료된 agent는 취소 불가
  }
  
  // 상태를 먼저 cancelled로 설정 (race condition 방지)
  agent.status = "cancelled";
  agent.completedAt = new Date();
  
  // 실행 중인 API 호출 취소
  const controller = abortControllers.get(agentId);
  if (controller) {
    controller.abort();
    abortControllers.delete(agentId);
  }
  
  console.log(`[Agent ${agentId}] Cancelled`);
  
  return true;
}

/**
 * Agent 상태 조회
 */
export function getAgent(agentId: string): Agent | undefined {
  return agents.get(agentId);
}

/**
 * 오래된 agent 정리 (1시간 이상)
 * - 완료된 agent: completedAt 기준 1시간
 * - running 상태도 createdAt 기준 1시간 지나면 정리 (stuck 방지)
 */
export function cleanupOldAgents(): void {
  const oneHourAgo = Date.now() - 60 * 60 * 1000;
  
  for (const [id, agent] of agents.entries()) {
    // 완료된 agent: completedAt 기준
    if (agent.completedAt && agent.completedAt.getTime() < oneHourAgo) {
      agents.delete(id);
      continue;
    }
    
    // running 상태도 1시간 지나면 정리 (stuck agent 방지)
    if (agent.status === "running" && agent.createdAt.getTime() < oneHourAgo) {
      console.log(`[Agent ${id}] Cleaning up stuck agent (running > 1h)`);
      agents.delete(id);
    }
  }
}

// Cleanup interval 참조 저장
let cleanupIntervalId: ReturnType<typeof setInterval> | null = null;

/**
 * 정기 cleanup 시작
 */
export function startCleanup(): void {
  if (cleanupIntervalId) return; // 이미 실행 중
  cleanupIntervalId = setInterval(cleanupOldAgents, 10 * 60 * 1000);
  console.log("[AgentManager] Cleanup interval started");
}

/**
 * 정기 cleanup 중지
 */
export function stopCleanup(): void {
  if (cleanupIntervalId) {
    clearInterval(cleanupIntervalId);
    cleanupIntervalId = null;
    console.log("[AgentManager] Cleanup interval stopped");
  }
}

// 자동 시작
startCleanup();
