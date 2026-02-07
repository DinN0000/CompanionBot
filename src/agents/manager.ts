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
    
    const response = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 2048,
      system: systemPrompt,
      messages: [
        {
          role: "user",
          content: `Please complete this task: ${agent.task}`,
        },
      ],
    });

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
    agent.status = "failed";
    agent.completedAt = new Date();
    agent.error = error instanceof Error ? error.message : String(error);
    
    console.error(`[Agent ${agent.id}] Failed:`, agent.error);
    
    // 실패도 알림
    await sendAgentResult(agent);
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
  
  // 실제로 실행 중인 API 호출을 취소할 수는 없지만
  // 상태를 cancelled로 표시하고 결과 전송 시 무시되도록 함
  agent.status = "cancelled";
  agent.completedAt = new Date();
  
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
 */
export function cleanupOldAgents(): void {
  const oneHourAgo = Date.now() - 60 * 60 * 1000;
  
  for (const [id, agent] of agents.entries()) {
    if (agent.completedAt && agent.completedAt.getTime() < oneHourAgo) {
      agents.delete(id);
    }
  }
}

// 10분마다 정리
setInterval(cleanupOldAgents, 10 * 60 * 1000);
