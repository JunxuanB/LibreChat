import { Controller, useForm } from 'react-hook-form';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { GraphEdge } from 'librechat-data-provider';
import type { UseFormReturn } from 'react-hook-form';
import type { ReactNode } from 'react';
import type { AgentForm } from '~/common';
import AgentHandoffs from '../AgentHandoffs';

let mockSelect: (id: string) => void;
let mockGetValues: UseFormReturn<AgentForm>['getValues'];
const mockSubmit = jest.fn();
jest.mock('~/hooks', () => ({ useLocalize: () => (key: string) => key }));
jest.mock('../AgentList', () => ({
  AddAgentSelect: ({ onSelect }: { onSelect: (id: string) => void }) => {
    mockSelect = onSelect;
    return null;
  },
  AgentRow: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  AgentSelectInline: () => null,
  agentIcon: () => null,
  useSelectableAgents: () => ({ options: [], getAgent: () => undefined }),
}));
jest.mock('../OrchestrationPattern', () => ({
  __esModule: true,
  default: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

function Harness({ edges = [] }: { edges?: GraphEdge[] }) {
  const methods = useForm<AgentForm>({ defaultValues: { edges } });
  mockGetValues = methods.getValues;
  return (
    <form aria-label="agent form" onSubmit={methods.handleSubmit(mockSubmit)}>
      <Controller
        name="edges"
        control={methods.control}
        render={({ field }) => <AgentHandoffs field={field} currentAgentId="parent" />}
      />
    </form>
  );
}

test('commits a handoff before immediate submission without touching non-handoff edges', async () => {
  const direct: GraphEdge = { from: 'parent', to: 'other', edgeType: 'direct' };
  render(<Harness edges={[direct]} />);
  act(() => {
    mockSelect('child');
    fireEvent.submit(screen.getByRole('form', { name: 'agent form' }));
  });
  const edges = [direct, { from: 'parent', to: 'child', edgeType: 'handoff' }];
  expect(mockGetValues('edges')).toEqual(edges);
  await waitFor(() =>
    expect(mockSubmit).toHaveBeenCalledWith(expect.objectContaining({ edges }), expect.anything()),
  );
});
