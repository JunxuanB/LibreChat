import type { AgentSubagentsConfig, GraphEdge } from 'librechat-data-provider';

/** Disable orchestration without losing subagent settings or non-handoff edges. */
export function removeOrchestration(subagents?: AgentSubagentsConfig, edges?: GraphEdge[]) {
  return {
    subagents: subagents ? { ...subagents, enabled: false } : undefined,
    edges: (edges ?? []).filter((edge) => edge.edgeType !== 'handoff'),
  };
}
