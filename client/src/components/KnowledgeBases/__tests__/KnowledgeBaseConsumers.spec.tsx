import type { ReactNode } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { FormProvider, useForm, useWatch } from 'react-hook-form';
import AgentKnowledgeBases from '~/components/SidePanel/Agents/AgentKnowledgeBases';

const mockQuery = {
  data: {
    knowledgeBases: [
      { _id: 'kb-1', name: 'Runbooks' },
      { _id: 'kb-2', name: 'Handbook' },
    ],
  },
  isLoading: false,
  isError: false,
  refetch: jest.fn(),
};

jest.mock(
  '@librechat/client',
  () => ({
    Button: ({ children, ...props }: any) => <button {...props}>{children}</button>,
    Spinner: (props: any) => <div role="status" {...props} />,
    OGDialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
      open ? <div role="dialog">{children}</div> : null,
    OGDialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  }),
  { virtual: true },
);

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string, values?: Record<string, string>) =>
    values?.[0] ? `${key}:${values[0]}` : key,
  useHasAccess: () => true,
}));

jest.mock('~/data-provider', () => ({
  useGetStartupConfig: () => ({ data: { interface: { knowledgeBases: true } } }),
  useKnowledgeBasesQuery: () => mockQuery,
}));

type AgentValues = { knowledge_base_ids?: string[] };

function AgentHarness({ onSave }: { onSave: (value: string[] | undefined) => void }) {
  const methods = useForm<AgentValues>({ defaultValues: { knowledge_base_ids: ['kb-1'] } });
  const selected = useWatch({ control: methods.control, name: 'knowledge_base_ids' });
  return (
    <FormProvider {...methods}>
      <AgentKnowledgeBases />
      <output data-testid="agent-selection">{selected?.join(',')}</output>
      <button type="button" onClick={() => onSave(methods.getValues('knowledge_base_ids'))}>
        save-agent
      </button>
    </FormProvider>
  );
}

describe('knowledge base consumers', () => {
  it('hydrates the agent form and saves picker/removal changes', () => {
    const onSave = jest.fn();
    render(<AgentHarness onSave={onSave} />);
    expect(screen.getByText('Runbooks')).toBeInTheDocument();
    expect(screen.getByTestId('agent-selection')).toHaveTextContent('kb-1');

    fireEvent.click(screen.getByRole('button', { name: 'com_ui_add' }));
    fireEvent.click(screen.getByRole('button', { name: 'Handbook' }));
    expect(screen.getByTestId('agent-selection')).toHaveTextContent('kb-1,kb-2');
    fireEvent.click(screen.getByRole('button', { name: 'com_ui_done' }));

    fireEvent.click(screen.getByRole('button', { name: 'com_ui_knowledge_remove:Runbooks' }));
    fireEvent.click(screen.getByRole('button', { name: 'save-agent' }));
    expect(onSave).toHaveBeenCalledWith(['kb-2']);
  });
});
