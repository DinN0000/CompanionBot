/**
 * Sub-agent 시스템 - 복잡한 작업을 독립적인 agent에게 위임
 */

export { setAgentBot, spawnAgent, listAgents, cancelAgent, getAgent } from "./manager.js";
export type { Agent, AgentStatus, AgentResult } from "./types.js";
