import React, { useState } from 'react';
import * as Ariakit from '@ariakit/react';
import userEvent from '@testing-library/user-event';
import { render, screen, within } from '@testing-library/react';
import type { TConversation } from 'librechat-data-provider';
import KnowledgeBasesSubMenu from '../KnowledgeBasesSubMenu';

const mockRefetch = jest.fn();
let mockQueryState = {
  data: {
    knowledgeBases: [
      { _id: 'kb-1', name: 'Product Documentation' },
      { _id: 'kb-2', name: 'Support Runbooks' },
    ],
  },
  isLoading: false,
  isError: false,
  refetch: mockRefetch,
};

let mockChatContext: {
  conversation: TConversation | null;
  setConversation: React.Dispatch<React.SetStateAction<TConversation | null>>;
};

jest.mock('~/data-provider', () => ({
  useKnowledgeBasesQuery: () => mockQueryState,
}));

jest.mock('~/Providers', () => ({
  useChatContext: () => mockChatContext,
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string, values?: Record<string, number>) => {
    if (key === 'com_ui_knowledge_bases') return 'Knowledge Bases';
    if (key === 'com_ui_knowledge_bases_selected') return `${values?.[0]} selected`;
    return key;
  },
}));

jest.mock('@librechat/client', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const R = require('react');
  return {
    Spinner: () => R.createElement('span', { 'aria-label': 'loading' }),
    usePopoverZIndex: () => 50,
  };
});

function Harness() {
  const [conversation, setConversation] = useState<TConversation | null>({
    conversationId: 'conversation',
    knowledge_base_ids: ['kb-1'],
  } as TConversation);
  mockChatContext = { conversation, setConversation };
  return (
    <Ariakit.MenuProvider>
      {/* eslint-disable-next-line i18next/no-literal-string */}
      <Ariakit.MenuButton>Tools</Ariakit.MenuButton>
      <Ariakit.Menu open={true}>
        <KnowledgeBasesSubMenu />
      </Ariakit.Menu>
      <output data-testid="selection">
        {(
          conversation as TConversation & { knowledge_base_ids?: string[] }
        ).knowledge_base_ids?.join(',')}
      </output>
    </Ariakit.MenuProvider>
  );
}

describe('KnowledgeBasesSubMenu', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockQueryState = {
      data: {
        knowledgeBases: [
          { _id: 'kb-1', name: 'Product Documentation' },
          { _id: 'kb-2', name: 'Support Runbooks' },
        ],
      },
      isLoading: false,
      isError: false,
      refetch: mockRefetch,
    };
  });

  it('quick-selects multiple knowledge bases and reports the compact count', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    expect(screen.getByText('1 selected')).toBeInTheDocument();
    await user.click(screen.getByText('Knowledge Bases'));

    const menu = screen.getByRole('menu', { name: 'Knowledge Bases' });
    expect(menu).toHaveStyle({ zIndex: 51, pointerEvents: 'auto' });
    await user.click(within(menu).getByRole('menuitemcheckbox', { name: 'Support Runbooks' }));

    expect(screen.getByTestId('selection')).toHaveTextContent('kb-1,kb-2');
    expect(menu).toBeVisible();
  });

  it('filters choices and clears the selection without exposing management actions', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByText('Knowledge Bases'));

    const menu = screen.getByRole('menu', { name: 'Knowledge Bases' });
    await user.type(
      within(menu).getByRole('textbox', { name: 'com_ui_filter_knowledge_bases_name' }),
      'support',
    );

    expect(within(menu).queryByText('Product Documentation')).not.toBeInTheDocument();
    expect(within(menu).getByText('Support Runbooks')).toBeInTheDocument();
    expect(within(menu).queryByText(/manage/i)).not.toBeInTheDocument();

    await user.click(within(menu).getByText('com_ui_knowledge_clear_selection'));
    expect(screen.getByTestId('selection')).toBeEmptyDOMElement();
  });
});
