import type { AgentSubagentsConfig, GraphEdge } from 'librechat-data-provider';
import type { FormSelection } from '../selectors';
import type { AgentItem } from '../types';
import { hasConfigurableSettings } from '../configurable';
import { removeOrchestration } from '../orchestration';
import { deriveSelectedItems } from '../selectors';
import { computeToggleAction } from '../mutations';

const item: AgentItem = {
  kind: 'builtin',
  id: 'orchestration',
  name: '',
  description: '',
  iconKey: 'orchestration',
};
const form: FormSelection = {
  execute_code: false,
  web_search: false,
  file_search: false,
  memory: false,
  artifacts: '',
  tools: [],
  skills: [],
  context_files: [],
  knowledge_files: [],
  code_files: [],
};
const handoff: GraphEdge = {
  from: 'parent',
  to: 'child',
  edgeType: 'handoff',
  prompt: 'Keep this',
};
const direct: GraphEdge = { from: 'parent', to: 'other', edgeType: 'direct' };

test('derives the native item from existing subagent and handoff configurations', () => {
  expect(deriveSelectedItems(form, [item], [])).toEqual([]);
  expect(deriveSelectedItems({ ...form, subagents: { enabled: true } }, [item], [])).toEqual([
    item,
  ]);
  expect(deriveSelectedItems({ ...form, edges: [handoff] }, [item], [])).toEqual([item]);
  expect(
    deriveSelectedItems(
      { ...form, edges: [direct], subagents: { enabled: false, agent_ids: ['child'] } },
      [item],
      [],
    ),
  ).toEqual([]);
});

test('adding opens settings instead of writing a bogus capability or plugin', () => {
  expect(computeToggleAction(item, { selected: false })).toEqual({ type: 'configure' });
  expect(computeToggleAction(item, { selected: true })).toEqual({ type: 'orchestration-remove' });
  expect(hasConfigurableSettings(item)).toBe(true);
});

test('removal explicitly disables subagents and preserves their settings and unrelated edges', () => {
  const subagents: AgentSubagentsConfig = {
    enabled: true,
    allowSelf: false,
    agent_ids: ['child'],
    shareFiles: true,
    graphs: [
      {
        name: 'Review',
        description: 'Review work',
        entry_agent_id: 'child',
        result_agent_id: 'child',
        agent_ids: ['child'],
        edges: [],
      },
    ],
  };
  expect(removeOrchestration(subagents, [handoff, direct])).toEqual({
    subagents: { ...subagents, enabled: false },
    edges: [direct],
  });
  expect(subagents.enabled).toBe(true);
  expect(removeOrchestration(undefined, [handoff])).toEqual({ subagents: undefined, edges: [] });
});
