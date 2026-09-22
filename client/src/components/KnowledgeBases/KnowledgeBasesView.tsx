import { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import {
  Button,
  Input,
  Label,
  OGDialog,
  OGDialogContent,
  Spinner,
  TextareaAutosize,
  useMediaQuery,
  useToastContext,
} from '@librechat/client';
import { Database, FilePlus2, Pencil, Plus, Share2, Trash2 } from 'lucide-react';
import { ResourceType } from 'librechat-data-provider';
import type { TFile } from 'librechat-data-provider';
import {
  useGetFiles,
  useGetStartupConfig,
  useKnowledgeBaseMutations,
  useKnowledgeBaseQuery,
  useKnowledgeConnectorsQuery,
} from '~/data-provider';
import type { KnowledgeBase } from '~/data-provider';
import { GenericGrantAccessDialog } from '~/components/Sharing';
import OpenSidebar from '~/components/Chat/Menus/OpenSidebar';
import { useLocalize } from '~/hooks';
import { isKnowledgeBasesEnabled } from './feature';

type DialogName = 'files' | 'sources' | null;

export function useKnowledgeBasesEnabled() {
  const { data } = useGetStartupConfig();
  return isKnowledgeBasesEnabled(data?.interface?.knowledgeBases);
}

export default function KnowledgeBasesView() {
  const enabled = useKnowledgeBasesEnabled();
  const navigate = useNavigate();
  const location = useLocation();
  const { knowledgeBaseId } = useParams();
  const localize = useLocalize();
  const [dialog, setDialog] = useState<DialogName>(null);
  const detail = useKnowledgeBaseQuery(knowledgeBaseId, enabled);
  const isCreate = location.pathname.endsWith('/new');
  const isEdit = location.pathname.endsWith('/edit');

  if (!enabled) {
    return (
      <div className="flex h-full items-center justify-center bg-presentation p-8 text-center">
        <div>
          <Database className="mx-auto mb-3 size-10 text-text-secondary" />
          <h1 className="text-xl font-semibold text-text-primary">
            {localize('com_ui_knowledge_disabled')}
          </h1>
        </div>
      </div>
    );
  }

  let content: React.ReactNode;
  if (isCreate) {
    content = <KnowledgeBaseForm />;
  } else if (!knowledgeBaseId) {
    content = <EmptySelection onCreate={() => navigate('/knowledge/new')} />;
  } else if (detail.isLoading) {
    content = (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );
  } else if (detail.data) {
    content = isEdit ? (
      <KnowledgeBaseForm knowledgeBase={detail.data} />
    ) : (
      <KnowledgeBaseDetail
        knowledgeBase={detail.data}
        onEdit={() => navigate(`/knowledge/${detail.data?._id}/edit`)}
        onAddFiles={() => setDialog('files')}
        onAddSource={() => setDialog('sources')}
      />
    );
  } else {
    content = (
      <div className="p-8 text-center text-text-secondary">
        {localize('com_ui_knowledge_not_found')}
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-presentation">
      <MobileSidebarToggle />
      <main className="min-h-0 min-w-0 flex-1 overflow-y-auto">{content}</main>

      {detail.data && (
        <>
          <AddFilesDialog
            open={dialog === 'files'}
            knowledgeBase={detail.data}
            onClose={() => setDialog(null)}
          />
          <SourceCatalogDialog
            open={dialog === 'sources'}
            onClose={() => setDialog(null)}
            onChooseFiles={() => setDialog('files')}
          />
        </>
      )}
    </div>
  );
}

function MobileSidebarToggle() {
  const isSmallScreen = useMediaQuery('(max-width: 768px)');
  if (!isSmallScreen) {
    return null;
  }
  return (
    <div className="flex shrink-0 items-center px-4 pt-3">
      <OpenSidebar />
    </div>
  );
}

function EmptySelection({ onCreate }: { onCreate: () => void }) {
  const localize = useLocalize();
  return (
    <div className="flex h-full items-center justify-center p-8 text-center">
      <div className="max-w-md">
        <Database className="mx-auto mb-4 size-12 text-text-secondary" />
        <h2 className="text-xl font-semibold text-text-primary">
          {localize('com_ui_knowledge_no_selection')}
        </h2>
        <p className="mt-2 text-sm text-text-secondary">
          {localize('com_ui_knowledge_no_selection_desc')}
        </p>
        <Button className="mt-5" onClick={onCreate}>
          <Plus className="mr-2 size-4" />
          {localize('com_ui_knowledge_create')}
        </Button>
      </div>
    </div>
  );
}

function KnowledgeBaseDetail({
  knowledgeBase,
  onEdit,
  onAddFiles,
  onAddSource,
}: {
  knowledgeBase: KnowledgeBase;
  onEdit: () => void;
  onAddFiles: () => void;
  onAddSource: () => void;
}) {
  const localize = useLocalize();
  const navigate = useNavigate();
  const { showToast } = useToastContext();
  const mutations = useKnowledgeBaseMutations();
  const resourceType = (ResourceType as unknown as Record<string, ResourceType>).KNOWLEDGE_BASE;
  const remove = () => {
    if (!window.confirm(localize('com_ui_knowledge_delete_confirm', { 0: knowledgeBase.name }))) {
      return;
    }
    mutations.remove.mutate(knowledgeBase._id, {
      onSuccess: () => {
        showToast({ status: 'success', message: localize('com_ui_knowledge_deleted') });
        navigate('/knowledge', { replace: true });
      },
    });
  };

  return (
    <div className="mx-auto max-w-5xl p-6 md:p-10">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-2xl font-semibold text-text-primary">{knowledgeBase.name}</h2>
          {knowledgeBase.description && (
            <p className="mt-2 max-w-2xl text-sm text-text-secondary">
              {knowledgeBase.description}
            </p>
          )}
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="icon"
            onClick={onEdit}
            aria-label={localize('com_ui_edit')}
          >
            <Pencil className="size-4" />
          </Button>
          {resourceType && (
            <GenericGrantAccessDialog
              resourceDbId={knowledgeBase._id}
              resourceName={knowledgeBase.name}
              resourceType={resourceType}
            >
              <Button variant="outline" size="icon" aria-label={localize('com_ui_share')}>
                <Share2 className="size-4" />
              </Button>
            </GenericGrantAccessDialog>
          )}
          <Button
            variant="destructive"
            size="icon"
            onClick={remove}
            aria-label={localize('com_ui_delete')}
          >
            <Trash2 className="size-4" />
          </Button>
        </div>
      </div>

      <div className="mt-8 flex flex-wrap gap-2">
        <Button onClick={onAddFiles}>
          <FilePlus2 className="mr-2 size-4" />
          {localize('com_ui_knowledge_add_files')}
        </Button>
        <Button variant="outline" onClick={onAddSource}>
          <Plus className="mr-2 size-4" />
          {localize('com_ui_knowledge_add_source')}
        </Button>
      </div>

      <section className="mt-6 overflow-hidden rounded-xl border border-border-light">
        <h3 className="border-b border-border-light px-4 py-3 font-medium text-text-primary">
          {localize('com_ui_knowledge_documents')}
        </h3>
        {(knowledgeBase.documents ?? []).length === 0 ? (
          <p className="p-8 text-center text-sm text-text-secondary">
            {localize('com_ui_knowledge_documents_empty')}
          </p>
        ) : (
          <table className="w-full text-left text-sm">
            <thead className="bg-surface-secondary text-xs text-text-secondary">
              <tr>
                <th className="px-4 py-2">{localize('com_ui_name')}</th>
                <th className="px-4 py-2">{localize('com_ui_status')}</th>
                <th className="w-12" />
              </tr>
            </thead>
            <tbody>
              {(knowledgeBase.documents ?? []).map((document) => (
                <tr key={document._id} className="border-t border-border-light">
                  <td className="px-4 py-3 text-text-primary">{document.name}</td>
                  <td className="px-4 py-3 text-text-secondary">{document.status}</td>
                  <td className="px-2">
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={localize('com_ui_delete')}
                      onClick={() =>
                        mutations.removeDocument.mutate({
                          id: knowledgeBase._id,
                          documentId: document._id,
                        })
                      }
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

function KnowledgeBaseForm({ knowledgeBase }: { knowledgeBase?: KnowledgeBase }) {
  const localize = useLocalize();
  const navigate = useNavigate();
  const mutations = useKnowledgeBaseMutations();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  useEffect(() => {
    setName(knowledgeBase?.name ?? '');
    setDescription(knowledgeBase?.description ?? '');
  }, [knowledgeBase]);
  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const input = { name: name.trim(), description: description.trim() };
    if (knowledgeBase) {
      mutations.update.mutate(
        { id: knowledgeBase._id, input },
        { onSuccess: () => navigate(`/knowledge/${knowledgeBase._id}`) },
      );
    } else {
      mutations.create.mutate(input, {
        onSuccess: (created) => navigate(`/knowledge/${created._id}`),
      });
    }
  };
  return (
    <div className="mx-auto max-w-3xl p-6 md:p-10">
      <form className="space-y-4" onSubmit={submit}>
        <h2 className="text-2xl font-semibold text-text-primary">
          {localize(knowledgeBase ? 'com_ui_knowledge_edit' : 'com_ui_knowledge_create')}
        </h2>
        <div>
          <Label htmlFor="knowledge-name">{localize('com_ui_name')}</Label>
          <Input
            id="knowledge-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            maxLength={120}
          />
        </div>
        <div>
          <Label id="knowledge-description-label" htmlFor="knowledge-description">
            {localize('com_ui_description')}
          </Label>
          <TextareaAutosize
            id="knowledge-description"
            aria-labelledby="knowledge-description-label"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            minRows={3}
            maxLength={1000}
            className="w-full rounded-lg border border-border-medium bg-transparent p-3 text-sm text-text-primary"
          />
        </div>
        <div className="flex justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() =>
              navigate(knowledgeBase ? `/knowledge/${knowledgeBase._id}` : '/knowledge')
            }
          >
            {localize('com_ui_cancel')}
          </Button>
          <Button type="submit" disabled={!name.trim()}>
            {localize('com_ui_save')}
          </Button>
        </div>
      </form>
    </div>
  );
}

function AddFilesDialog({
  open,
  knowledgeBase,
  onClose,
}: {
  open: boolean;
  knowledgeBase: KnowledgeBase;
  onClose: () => void;
}) {
  const localize = useLocalize();
  const { data: files = [] } = useGetFiles<TFile[]>({ enabled: open });
  const mutations = useKnowledgeBaseMutations();
  const linkedIds = useMemo(
    () => new Set((knowledgeBase.documents ?? []).map((document) => document.file_id)),
    [knowledgeBase.documents],
  );
  return (
    <OGDialog open={open} onOpenChange={(next) => !next && onClose()}>
      <OGDialogContent className="w-11/12 max-w-xl">
        <div className="p-2">
          <h2 className="text-lg font-semibold text-text-primary">
            {localize('com_ui_knowledge_add_files')}
          </h2>
          <p className="mt-1 text-sm text-text-secondary">
            {localize('com_ui_knowledge_add_files_desc')}
          </p>
          <div className="mt-4 max-h-80 overflow-y-auto rounded-lg border border-border-light">
            {files.length === 0 ? (
              <p className="p-6 text-center text-sm text-text-secondary">
                {localize('com_ui_knowledge_no_files')}
              </p>
            ) : (
              files.map((file) => (
                <div
                  key={file.file_id}
                  className="flex items-center justify-between border-b border-border-light px-3 py-2 last:border-0"
                >
                  <span className="min-w-0 truncate text-sm text-text-primary">
                    {file.filename}
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={linkedIds.has(file.file_id) || mutations.addDocument.isLoading}
                    onClick={() => mutations.addDocument.mutate({ id: knowledgeBase._id, file })}
                  >
                    {localize('com_ui_add')}
                  </Button>
                </div>
              ))
            )}
          </div>
        </div>
      </OGDialogContent>
    </OGDialog>
  );
}

function SourceCatalogDialog({
  open,
  onClose,
  onChooseFiles,
}: {
  open: boolean;
  onClose: () => void;
  onChooseFiles: () => void;
}) {
  const localize = useLocalize();
  const connectors = useKnowledgeConnectorsQuery(open);
  const advertised = (connectors.data?.connectors ?? []).filter((connector) => connector.enabled);
  return (
    <OGDialog open={open} onOpenChange={(next) => !next && onClose()}>
      <OGDialogContent className="w-11/12 max-w-2xl">
        <div className="p-2">
          <h2 className="text-lg font-semibold text-text-primary">
            {localize('com_ui_knowledge_add_source')}
          </h2>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <button
              type="button"
              onClick={onChooseFiles}
              className="rounded-xl border border-border-light p-4 text-left hover:bg-surface-hover"
            >
              <FilePlus2 className="mb-3 size-5" />
              <span className="font-medium text-text-primary">
                {localize('com_ui_knowledge_uploads')}
              </span>
              <span className="mt-1 block text-xs text-text-secondary">
                {localize('com_ui_knowledge_uploads_desc')}
              </span>
            </button>
            {advertised.map((connector) => (
              <button
                key={connector.id}
                type="button"
                className="rounded-xl border border-border-light p-4 text-left hover:bg-surface-hover"
              >
                <Database className="mb-3 size-5" />
                <span className="font-medium text-text-primary">{connector.name}</span>
                {connector.description && (
                  <span className="mt-1 block text-xs text-text-secondary">
                    {connector.description}
                  </span>
                )}
              </button>
            ))}
          </div>
          {advertised.length === 0 && (
            <p className="mt-4 text-xs text-text-secondary">
              {localize('com_ui_knowledge_connectors_empty')}
            </p>
          )}
        </div>
      </OGDialogContent>
    </OGDialog>
  );
}
