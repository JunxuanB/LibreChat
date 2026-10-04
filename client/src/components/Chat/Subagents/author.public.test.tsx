import { RecoilRoot } from 'recoil';
import { render, screen, waitFor } from '@testing-library/react';
import { dataService, EModelEndpoint } from 'librechat-data-provider';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { TMessage } from 'librechat-data-provider';
import { ShareContext } from '~/Providers/ShareContext';
import { agentAuthor, messageAuthor } from './author';

jest.mock('librechat-data-provider', () => {
  const actual = jest.requireActual('librechat-data-provider');
  return {
    ...actual,
    dataService: { ...actual.dataService, getAIEndpoints: jest.fn().mockResolvedValue({}) },
  };
});

/** Keep the real query hook; only its HTTP data service is replaced below. */
jest.mock('~/data-provider', () => ({
  useGetEndpointsQuery: jest.requireActual('~/data-provider/Endpoints/queries')
    .useGetEndpointsQuery,
}));
jest.mock('~/components/Endpoints/Icon', () => ({
  __esModule: true,
  default: () => <span data-testid="generic-avatar" />,
}));
jest.mock('~/components/Endpoints/ConvoIconURL', () => ({
  __esModule: true,
  default: ({ iconURL }: { iconURL?: string }) => (
    <span data-testid="historical-avatar" data-icon={iconURL} />
  ),
}));

const historicalMessage: TMessage = {
  messageId: 'parent',
  parentMessageId: null,
  conversationId: 'shared',
  isCreatedByUser: false,
  text: '',
  sender: 'Historical Parent',
  model: 'agent_deleted',
  endpoint: EModelEndpoint.agents,
  iconURL: '/historical.png',
};

it('draws public-share authors without private requests and enables them again in chat', async () => {
  const getEndpoints = jest.mocked(dataService.getAIEndpoints);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const child = agentAuthor(undefined, 'Agent');
  const parent = messageAuthor(historicalMessage, undefined, 'Parent agent');
  const tree = (isSharedConvo: boolean) => (
    <RecoilRoot>
      <QueryClientProvider client={queryClient}>
        <ShareContext.Provider value={{ isSharedConvo }}>
          {child.icon}
          {parent.icon}
        </ShareContext.Provider>
      </QueryClientProvider>
    </RecoilRoot>
  );
  const { rerender } = render(tree(true));

  expect(screen.getByTestId('generic-avatar')).toBeInTheDocument();
  expect(screen.getByTestId('historical-avatar')).toHaveAttribute('data-icon', '/historical.png');
  expect(queryClient.isFetching()).toBe(0);
  expect(getEndpoints).not.toHaveBeenCalled();

  rerender(tree(false));
  await waitFor(() => expect(getEndpoints).toHaveBeenCalledTimes(1));
  queryClient.clear();
});
