/**
 * Sub-agent 시스템 타입 정의
 */

export type AgentStatus = "running" | "completed" | "failed" | "cancelled";

export interface Agent {
  id: string;
  task: string;
  status: AgentStatus;
  chatId: number;
  createdAt: Date;
  completedAt?: Date;
  result?: string;
  error?: string;
}

export interface AgentResult {
  success: boolean;
  result?: string;
  error?: string;
}
