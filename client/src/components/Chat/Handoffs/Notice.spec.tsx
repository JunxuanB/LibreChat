import React from 'react';
import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import { EModelEndpoint, QueryKeys } from 'librechat-data-provider';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { TConversation } from 'librechat-data-provider';
import AgentRoutingNotice, { agentRoutingKey } from './Notice';

jest.mock('~/Providers/AgentsMapContext', () => ({
  useAgentsMapContext: () => ({
    agent_target: { id: 'agent_target', name: 'Specialist' },
  }),
}));
jest.mock('~/data-provider', () => ({
  useGetEndpointsQuery: () => ({
    data: { agents: { conversationHandoffsEnabled: true } },
  }),
  useGetStartupConfig: () => ({ data: { modelSpecs: { enforce: false } } }),
}));
jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string, replacements?: { 0?: string }) => {
    if (key === 'com_ui_agent_handoff_future_agent') {
      return `Future messages will go to ${replacements?.[0]}.`;
    }
    return key;
  },
}));

it('shows a committed destination but no Switch back when its previous agent is unavailable', async () => {
  const conversation = {
    conversationId: 'convo-1',
    endpoint: EModelEndpoint.agents,
    agent_id: 'agent_target',
    agentRoutingRevision: 2,
  } as TConversation;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData([QueryKeys.endpoints], {
    [EModelEndpoint.agents]: { conversationHandoffsEnabled: true },
  });
  client.setQueryData(agentRoutingKey('convo-1', 2), {
    agentId: 'agent_target',
    revision: 2,
    automaticHandoffsEnabled: true,
    previousAgentId: 'agent_removed',
    transitionId: 'transition-1',
  });
  render(
    <QueryClientProvider client={client}>
      <AgentRoutingNotice conversation={conversation} setConversation={jest.fn()} />
    </QueryClientProvider>,
  );
  expect(await screen.findByRole('status')).toHaveTextContent(
    'Future messages will go to Specialist.',
  );
  expect(screen.queryByRole('button', { name: /switch back/i })).not.toBeInTheDocument();
});
