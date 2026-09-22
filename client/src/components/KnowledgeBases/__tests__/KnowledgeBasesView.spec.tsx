import type { ReactNode } from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { Permissions } from 'librechat-data-provider';
import KnowledgeBasesView from '../KnowledgeBasesView';

const mockState = {
  startup: { data: { interface: { knowledgeBases: true } } } as any,
  list: {} as any,
  detail: {} as any,
  files: {} as any,
  connectors: {} as any,
  sources: {} as any,
  access: new Map<any, boolean>(),
  create: { mutate: jest.fn(), isError: false, isLoading: false },
  update: { mutate: jest.fn(), isError: false, isLoading: false },
  remove: { mutate: jest.fn(), isError: false, isLoading: false },
  addDocument: { mutate: jest.fn(), isError: false, isLoading: false },
  removeDocument: { mutate: jest.fn(), isError: false, isLoading: false },
  sourceCreate: { mutate: jest.fn(), reset: jest.fn(), isError: false, isLoading: false },
  sourceUpdate: { mutate: jest.fn(), isError: false, isLoading: false },
  sourceSync: { mutate: jest.fn(), isError: false, isLoading: false },
  sourceRemove: { mutate: jest.fn(), isError: false, isLoading: false },
  toast: jest.fn(),
};
const mocks = mockState;

jest.mock(
  '@librechat/client',
  () => ({
    Button: ({ children, ...props }: any) => <button {...props}>{children}</button>,
    Input: (props: any) => <input {...props} />,
    Label: ({ children, ...props }: any) => <label {...props}>{children}</label>,
    TextareaAutosize: ({ minRows: _minRows, maxRows: _maxRows, ...props }: any) => (
      <textarea {...props} />
    ),
    Spinner: (props: any) => <div role="status" {...props} />,
    OGDialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
      open ? <div role="dialog">{children}</div> : null,
    OGDialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    useMediaQuery: () => false,
    useToastContext: () => ({ showToast: mockState.toast }),
  }),
  { virtual: true },
);

jest.mock('~/components/Sharing', () => ({
  GenericGrantAccessDialog: ({ children }: { children: ReactNode }) => (
    <div data-testid="share-control">{children}</div>
  ),
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string, values?: Record<string, string>) =>
    values?.[0] ? `${key}:${values[0]}` : key,
  useAuthContext: () => ({ user: { role: 'USER' }, roles: { USER: {} } }),
  useHasAccess: ({ permission }: { permission: unknown }) => mocks.access.get(permission) ?? true,
}));

jest.mock('~/data-provider', () => ({
  useGetStartupConfig: () => mocks.startup,
  useKnowledgeBasesQuery: () => mocks.list,
  useKnowledgeBaseQuery: () => mocks.detail,
  useGetFiles: () => mocks.files,
  useKnowledgeConnectorsQuery: () => mocks.connectors,
  useKnowledgeSourcesQuery: () => mocks.sources,
  useKnowledgeBaseMutations: () => ({
    create: mocks.create,
    update: mocks.update,
    remove: mocks.remove,
    addDocument: mocks.addDocument,
    removeDocument: mocks.removeDocument,
  }),
  useKnowledgeSourceMutations: () => ({
    create: mocks.sourceCreate,
    update: mocks.sourceUpdate,
    sync: mocks.sourceSync,
    remove: mocks.sourceRemove,
  }),
}));

const base = {
  _id: 'kb-1',
  name: 'Runbooks',
  description: 'Operational guidance',
  documentCount: 1,
  documents: [{ _id: 'doc-1', file_id: 'file-1', name: 'Existing.pdf', status: 'ready' }],
};

function Location() {
  return <output data-testid="location">{useLocation().pathname}</output>;
}

function renderView(path = '/knowledge') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Location />
      <Routes>
        <Route path="/knowledge" element={<KnowledgeBasesView />} />
        <Route path="/knowledge/new" element={<KnowledgeBasesView />} />
        <Route path="/knowledge/:knowledgeBaseId" element={<KnowledgeBasesView />} />
        <Route path="/knowledge/:knowledgeBaseId/edit" element={<KnowledgeBasesView />} />
        <Route path="/c/new" element={<div data-testid="chat-route" />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  mocks.startup = { data: { interface: { knowledgeBases: true } } };
  mocks.access.clear();
  mocks.list = {
    data: { knowledgeBases: [base] },
    isLoading: false,
    isError: false,
    refetch: jest.fn(),
  };
  mocks.detail = { data: base, isLoading: false, isError: false, refetch: jest.fn() };
  mocks.files = {
    data: [
      { file_id: 'file-1', filename: 'Existing.pdf' },
      { file_id: 'file-2', filename: 'New.pdf' },
    ],
    isLoading: false,
    isError: false,
    refetch: jest.fn(),
  };
  mocks.connectors = {
    data: { connectors: [] },
    isLoading: false,
    isError: false,
    refetch: jest.fn(),
  };
  mocks.sources = { data: { sources: [] }, isLoading: false, isError: false, refetch: jest.fn() };
  for (const mutation of [
    mocks.create,
    mocks.update,
    mocks.remove,
    mocks.addDocument,
    mocks.removeDocument,
    mocks.sourceCreate,
    mocks.sourceUpdate,
    mocks.sourceSync,
    mocks.sourceRemove,
  ]) {
    mutation.mutate.mockReset();
    mutation.isError = false;
    mutation.isLoading = false;
  }
  mocks.sourceCreate.reset.mockReset();
  mocks.toast.mockReset();
  jest.spyOn(window, 'confirm').mockReturnValue(true);
});

describe('KnowledgeBasesView', () => {
  it('renders detail loading and retries detail failures', () => {
    mocks.detail = { isLoading: true, isError: false, refetch: jest.fn() };
    const { unmount } = renderView();
    expect(within(screen.getByRole('main')).queryByRole('status')).not.toBeInTheDocument();
    unmount();

    const loading = renderView('/knowledge/kb-1');
    expect(within(screen.getByRole('main')).getByRole('status')).toBeInTheDocument();
    loading.unmount();

    const refetch = jest.fn();
    mocks.detail = { isLoading: false, isError: true, refetch };
    renderView('/knowledge/kb-1');
    fireEvent.click(screen.getByRole('button', { name: 'com_ui_retry' }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('creates and edits in the main canvas and confirms deletion', () => {
    mocks.create.mutate.mockImplementation((_input: unknown, options: any) =>
      options.onSuccess({ _id: 'kb-new' }),
    );
    const { unmount } = renderView('/knowledge/new');
    expect(screen.getByTestId('location')).toHaveTextContent('/knowledge/new');
    fireEvent.change(screen.getByLabelText('com_ui_name'), { target: { value: ' New base ' } });
    fireEvent.change(screen.getByLabelText('com_ui_description'), { target: { value: ' Notes ' } });
    fireEvent.click(screen.getByRole('button', { name: 'com_ui_save' }));
    expect(mocks.create.mutate).toHaveBeenCalledWith(
      { name: 'New base', description: 'Notes' },
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );
    expect(screen.getByTestId('location')).toHaveTextContent('/knowledge/kb-new');

    unmount();
    renderView('/knowledge/kb-1');
    fireEvent.click(screen.getByRole('button', { name: 'com_ui_edit' }));
    expect(screen.getByTestId('location')).toHaveTextContent('/knowledge/kb-1/edit');
    fireEvent.change(screen.getByLabelText('com_ui_name'), { target: { value: 'Edited' } });
    fireEvent.click(screen.getByRole('button', { name: 'com_ui_save' }));
    expect(mocks.update.mutate).toHaveBeenCalledWith(
      { id: 'kb-1', input: { name: 'Edited', description: 'Operational guidance' } },
      expect.any(Object),
    );

    fireEvent.click(screen.getByRole('button', { name: 'com_ui_cancel' }));
    fireEvent.click(screen.getByRole('button', { name: 'com_ui_delete' }));
    expect(window.confirm).toHaveBeenCalledWith('com_ui_knowledge_delete_confirm:Runbooks');
    expect(mocks.remove.mutate).toHaveBeenCalledWith('kb-1', expect.any(Object));
  });

  it('adds an available file and confirms document removal', () => {
    renderView('/knowledge/kb-1');
    fireEvent.click(screen.getByRole('button', { name: 'com_ui_knowledge_add_files' }));
    const dialog = screen.getByRole('dialog');
    const existingRow = within(dialog).getByText('Existing.pdf').parentElement!;
    expect(within(existingRow).getByRole('button', { name: 'com_ui_add' })).toBeDisabled();
    fireEvent.click(within(within(dialog).getByText('New.pdf').parentElement!).getByRole('button'));
    expect(mocks.addDocument.mutate).toHaveBeenCalledWith({
      id: 'kb-1',
      file: expect.objectContaining({ file_id: 'file-2' }),
    });

    fireEvent.click(
      screen.getByRole('button', { name: 'com_ui_knowledge_document_delete:Existing.pdf' }),
    );
    expect(window.confirm).toHaveBeenCalledWith(
      'com_ui_knowledge_document_delete_confirm:Existing.pdf',
    );
    expect(mocks.removeDocument.mutate).toHaveBeenCalledWith({
      id: 'kb-1',
      documentId: 'doc-1',
    });
  });

  it('builds connector config while keeping secret values isolated', () => {
    mocks.connectors = {
      data: {
        connectors: [
          {
            type: 'custom_api',
            name: 'Custom API',
            description: 'Search a service',
            fields: [
              { key: 'paths', label: 'Paths', type: 'string_array', required: true },
              { key: 'token', label: 'Token', type: 'password', secret: true, required: true },
              { key: 'region', label: 'Region', type: 'text' },
            ],
          },
        ],
      },
      isLoading: false,
      isError: false,
      refetch: jest.fn(),
    };
    renderView('/knowledge/kb-1');
    fireEvent.click(screen.getByRole('button', { name: 'com_ui_knowledge_add_source' }));
    fireEvent.click(screen.getByRole('button', { name: /Custom API/ }));
    fireEvent.change(screen.getByLabelText('Paths'), { target: { value: '/one\n/two, /three' } });
    const secret = screen.getByLabelText('Token');
    expect(secret).toHaveAttribute('type', 'password');
    expect(secret).toHaveAttribute('autocomplete', 'new-password');
    fireEvent.change(secret, { target: { value: 's3cr3t' } });
    fireEvent.change(screen.getByLabelText('Region'), { target: { value: 'us-east' } });
    fireEvent.click(screen.getByRole('button', { name: 'com_ui_knowledge_connect' }));

    expect(mocks.sourceCreate.mutate).toHaveBeenCalledWith(
      {
        type: 'custom_api',
        name: 'Custom API',
        config: { paths: ['/one', '/two', '/three'], region: 'us-east' },
        credentials: { token: 's3cr3t' },
      },
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );
  });

  it('runs manual source sync and confirms source deletion', () => {
    mocks.sources = {
      data: {
        sources: [{ _id: 'source-1', name: 'Docs site', type: 'website', syncStatus: 'ready' }],
      },
      isLoading: false,
      isError: false,
      refetch: jest.fn(),
    };
    renderView('/knowledge/kb-1');
    fireEvent.click(screen.getByRole('button', { name: 'com_ui_knowledge_source_sync:Docs site' }));
    expect(mocks.sourceSync.mutate).toHaveBeenCalledWith('source-1');
    fireEvent.click(
      screen.getByRole('button', { name: 'com_ui_knowledge_source_delete:Docs site' }),
    );
    expect(window.confirm).toHaveBeenCalledWith('com_ui_knowledge_source_delete_confirm:Docs site');
    expect(mocks.sourceRemove.mutate).toHaveBeenCalledWith('source-1');
  });

  it('edits connector configuration and rotates write-only credentials', () => {
    mocks.connectors = {
      data: {
        connectors: [
          {
            type: 'website',
            name: 'Website',
            fields: [
              { key: 'url', label: 'URL', type: 'url', required: true },
              { key: 'token', label: 'Token', type: 'password', secret: true },
            ],
          },
        ],
      },
      isLoading: false,
      isError: false,
      refetch: jest.fn(),
    };
    mocks.sources = {
      data: {
        sources: [
          {
            _id: 'source-1',
            name: 'Docs site',
            type: 'website',
            config: { url: 'https://old.example/docs' },
            accessMode: 'shared_snapshot',
            syncStatus: 'ready',
          },
        ],
      },
      isLoading: false,
      isError: false,
      refetch: jest.fn(),
    };

    renderView('/knowledge/kb-1');
    expect(screen.getByText('com_ui_knowledge_source_shared_snapshot')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'com_ui_knowledge_source_edit:Docs site' }));
    fireEvent.change(screen.getByLabelText('URL'), {
      target: { value: 'https://new.example/docs' },
    });
    fireEvent.change(screen.getByLabelText('Token'), { target: { value: 'replacement' } });
    fireEvent.click(screen.getByRole('button', { name: 'com_ui_save' }));

    expect(mocks.sourceUpdate.mutate).toHaveBeenCalledWith(
      {
        sourceId: 'source-1',
        input: {
          name: 'Docs site',
          config: { url: 'https://new.example/docs' },
          credentials: { token: 'replacement' },
        },
      },
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );
  });

  it('enforces use, create, share, and feature gates', () => {
    mocks.access.set(Permissions.USE, false);
    const { unmount } = renderView('/knowledge');
    expect(screen.getByTestId('chat-route')).toBeInTheDocument();
    unmount();

    mocks.access.set(Permissions.USE, true);
    mocks.access.set(Permissions.CREATE, false);
    mocks.access.set(Permissions.SHARE, false);
    const noCreate = renderView('/knowledge/new');
    expect(screen.getByTestId('location')).toHaveTextContent('/knowledge');
    noCreate.unmount();
    renderView('/knowledge/kb-1');
    expect(screen.queryByTestId('share-control')).not.toBeInTheDocument();
  });
});
