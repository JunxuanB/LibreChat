import type { ButtonHTMLAttributes, InputHTMLAttributes } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import KnowledgeBasesSidePanel from '../KnowledgeBasesSidePanel';

const mockList = jest.fn();

jest.mock('@librechat/client', () => ({
  Button: ({ children, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
  FilterInput: ({
    inputId,
    label,
    containerClassName: _containerClassName,
    ...props
  }: InputHTMLAttributes<HTMLInputElement> & {
    inputId: string;
    label: string;
    containerClassName?: string;
  }) => <input id={inputId} aria-label={label} {...props} />,
  Spinner: () => <div role="status" />,
}));

jest.mock('~/data-provider', () => ({
  useGetStartupConfig: () => ({ data: { interface: { knowledgeBases: true } } }),
  useKnowledgeBasesQuery: () => mockList(),
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string, values?: Record<string, string>) =>
    values?.[0] ? `${key}:${values[0]}` : key,
}));

function Location() {
  return <output data-testid="location">{useLocation().pathname}</output>;
}

function renderPanel(path = '/knowledge') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Location />
      <Routes>
        <Route path="/knowledge" element={<KnowledgeBasesSidePanel />} />
        <Route path="/knowledge/new" element={<KnowledgeBasesSidePanel />} />
        <Route path="/knowledge/:knowledgeBaseId" element={<KnowledgeBasesSidePanel />} />
      </Routes>
    </MemoryRouter>,
  );
}

const bases = [
  { _id: 'kb-1', name: 'Runbooks', documentCount: 2 },
  { _id: 'kb-2', name: 'Product notes', documentCount: 1 },
];

describe('KnowledgeBasesSidePanel', () => {
  beforeEach(() => {
    mockList.mockReturnValue({
      data: { knowledgeBases: bases },
      isLoading: false,
      isError: false,
      refetch: jest.fn(),
    });
  });

  it('filters, selects, and marks the route-active knowledge base', () => {
    renderPanel('/knowledge/kb-1');

    expect(screen.getByRole('button', { name: /Runbooks/ })).toHaveAttribute(
      'aria-current',
      'page',
    );
    fireEvent.change(screen.getByLabelText('com_ui_filter_knowledge_bases_name'), {
      target: { value: 'product' },
    });
    expect(screen.queryByText('Runbooks')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Product notes/ }));
    expect(screen.getByTestId('location')).toHaveTextContent('/knowledge/kb-2');
  });

  it('opens create in the main knowledge view', () => {
    renderPanel();
    const createButton = screen.getByRole('button', { name: 'com_ui_knowledge_create' });
    expect(createButton).toHaveAttribute('type', 'button');
    fireEvent.click(createButton);
    expect(screen.getByTestId('location')).toHaveTextContent('/knowledge/new');
  });

  it('renders loading, empty, and retry states', () => {
    mockList.mockReturnValue({ isLoading: true, isError: false, refetch: jest.fn() });
    const { unmount } = renderPanel();
    expect(screen.getAllByRole('status')).toHaveLength(2);
    unmount();

    mockList.mockReturnValue({
      data: { knowledgeBases: [] },
      isLoading: false,
      isError: false,
      refetch: jest.fn(),
    });
    const empty = renderPanel();
    expect(screen.getByText('com_ui_knowledge_empty')).toBeInTheDocument();
    empty.unmount();

    const refetch = jest.fn();
    mockList.mockReturnValue({ isLoading: false, isError: true, refetch });
    renderPanel();
    const retryButton = screen.getByRole('button', { name: 'com_ui_retry' });
    expect(retryButton).toHaveAttribute('type', 'button');
    fireEvent.click(retryButton);
    expect(refetch).toHaveBeenCalledTimes(1);
  });
});
