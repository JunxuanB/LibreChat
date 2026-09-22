import { useEffect, useMemo, useState } from 'react';
import { Navigate, useLocation, useNavigate, useParams } from 'react-router-dom';
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
import { Database, FilePlus2, Pencil, Plus, RefreshCw, Share2, Trash2 } from 'lucide-react';
import { PermissionTypes, Permissions, ResourceType } from 'librechat-data-provider';
import type { TFile } from 'librechat-data-provider';
import {
  useGetFiles,
  useGetStartupConfig,
  useKnowledgeBaseMutations,
  useKnowledgeBaseQuery,
  useKnowledgeConnectorsQuery,
  useKnowledgeSourcesQuery,
  useKnowledgeSourceMutations,
} from '~/data-provider';
import type {
  KnowledgeBase,
  KnowledgeConnector,
  KnowledgeConnectorField,
  KnowledgeSource,
} from '~/data-provider';
import { GenericGrantAccessDialog } from '~/components/Sharing';
import OpenSidebar from '~/components/Chat/Menus/OpenSidebar';
import { useAuthContext, useHasAccess, useLocalize } from '~/hooks';
import { isKnowledgeBaseActionEnabled, isKnowledgeBasesEnabled } from './feature';
import { buildKnowledgeSourceInput } from './sourceConfig';

type DialogName = 'files' | 'sources' | null;

export default function KnowledgeBasesView() {
  const { data: startupConfig } = useGetStartupConfig();
  const featureConfig = startupConfig?.interface?.knowledgeBases;
  const { user, roles } = useAuthContext();
  const hasUseAccess = useHasAccess({
    permissionType: PermissionTypes.KNOWLEDGE_BASES,
    permission: Permissions.USE,
  });
  const hasCreateAccess = useHasAccess({
    permissionType: PermissionTypes.KNOWLEDGE_BASES,
    permission: Permissions.CREATE,
  });
  const hasShareAccess = useHasAccess({
    permissionType: PermissionTypes.KNOWLEDGE_BASES,
    permission: Permissions.SHARE,
  });
  const featureEnabled = isKnowledgeBasesEnabled(featureConfig);
  const enabled = featureEnabled && hasUseAccess;
  const canCreate = hasCreateAccess && isKnowledgeBaseActionEnabled(featureConfig, 'create');
  const canShare = hasShareAccess && isKnowledgeBaseActionEnabled(featureConfig, 'share');
  const navigate = useNavigate();
  const location = useLocation();
  const { knowledgeBaseId } = useParams();
  const localize = useLocalize();
  const [dialog, setDialog] = useState<DialogName>(null);
  const detail = useKnowledgeBaseQuery(knowledgeBaseId, enabled);
  const isCreate = location.pathname.endsWith('/new');
  const isEdit = location.pathname.endsWith('/edit');

  const rolesLoaded = user?.role != null && roles?.[user.role] != null;
  if (!rolesLoaded) {
    return (
      <div className="flex h-full items-center justify-center bg-presentation">
        <Spinner className="text-text-secondary" aria-label={localize('com_ui_loading')} />
      </div>
    );
  }

  if (!hasUseAccess) {
    return <Navigate to="/c/new" replace />;
  }

  if (!featureEnabled) {
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

  if (isCreate && !canCreate) {
    return <Navigate to="/knowledge" replace />;
  }

  let content: React.ReactNode;
  if (isCreate) {
    content = <KnowledgeBaseForm />;
  } else if (!knowledgeBaseId) {
    content = (
      <EmptySelection canCreate={canCreate} onCreate={() => navigate('/knowledge/new')} />
    );
  } else if (detail.isLoading) {
    content = (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );
  } else if (detail.isError) {
    content = <QueryError onRetry={() => void detail.refetch()} />;
  } else if (detail.data) {
    content = isEdit ? (
      <KnowledgeBaseForm knowledgeBase={detail.data} />
    ) : (
      <KnowledgeBaseDetail
        knowledgeBase={detail.data}
        onEdit={() => navigate(`/knowledge/${detail.data?._id}/edit`)}
        onAddFiles={() => setDialog('files')}
        onAddSource={() => setDialog('sources')}
        canShare={canShare}
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
            knowledgeBaseId={detail.data._id}
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

function EmptySelection({ canCreate, onCreate }: { canCreate: boolean; onCreate: () => void }) {
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
        {canCreate && (
          <Button className="mt-5" onClick={onCreate}>
            <Plus className="mr-2 size-4" />
            {localize('com_ui_knowledge_create')}
          </Button>
        )}
      </div>
    </div>
  );
}

function QueryError({ onRetry }: { onRetry: () => void }) {
  const localize = useLocalize();
  return (
    <div role="alert" className="flex flex-col items-center justify-center gap-3 p-8 text-center">
      <p className="text-sm text-text-secondary">{localize('com_ui_knowledge_load_error')}</p>
      <Button type="button" size="sm" variant="outline" onClick={onRetry}>
        {localize('com_ui_retry')}
      </Button>
    </div>
  );
}

function KnowledgeBaseDetail({
  knowledgeBase,
  onEdit,
  onAddFiles,
  onAddSource,
  canShare,
}: {
  knowledgeBase: KnowledgeBase;
  onEdit: () => void;
  onAddFiles: () => void;
  onAddSource: () => void;
  canShare: boolean;
}) {
  const localize = useLocalize();
  const navigate = useNavigate();
  const { showToast } = useToastContext();
  const mutations = useKnowledgeBaseMutations();
  const resourceType = ResourceType.KNOWLEDGE_BASE;
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
          {canShare && (
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
        {mutations.removeDocument.isError && (
          <p role="alert" className="px-4 py-2 text-sm text-text-destructive">
            {localize('com_ui_knowledge_document_delete_error')}
          </p>
        )}
        {(knowledgeBase.documents ?? []).length === 0 ? (
          <p className="p-8 text-center text-sm text-text-secondary">
            {localize('com_ui_knowledge_documents_empty')}
          </p>
        ) : (
          <table className="w-full text-left text-sm">
            <thead className="bg-surface-secondary text-xs text-text-secondary">
              <tr>
                <th className="px-4 py-2">{localize('com_ui_name')}</th>
                <th className="px-4 py-2">{localize('com_ui_knowledge_status')}</th>
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
                      aria-label={localize('com_ui_knowledge_document_delete', {
                        0: document.name,
                      })}
                      onClick={() => {
                        if (
                          window.confirm(
                            localize('com_ui_knowledge_document_delete_confirm', {
                              0: document.name,
                            }),
                          )
                        ) {
                          mutations.removeDocument.mutate({
                            id: knowledgeBase._id,
                            documentId: document._id,
                          });
                        }
                      }}
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
      <KnowledgeSources knowledgeBaseId={knowledgeBase._id} />
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
          {(mutations.create.isError || mutations.update.isError) && (
            <p role="alert" className="text-sm text-text-destructive">
              {localize('com_ui_knowledge_save_error')}
            </p>
          )}
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

function KnowledgeSources({ knowledgeBaseId }: { knowledgeBaseId: string }) {
  const localize = useLocalize();
  const query = useKnowledgeSourcesQuery(knowledgeBaseId);
  const mutations = useKnowledgeSourceMutations(knowledgeBaseId);
  const [editing, setEditing] = useState<KnowledgeSource | null>(null);
  const sources = query.data?.sources ?? [];
  if (query.isLoading)
    return (
      <div className="flex justify-center p-6" aria-label={localize('com_ui_loading')}>
        <Spinner />
      </div>
    );
  if (query.isError) return <QueryError onRetry={() => void query.refetch()} />;
  if (sources.length === 0) return null;
  return (
    <>
      <section className="mt-6 overflow-hidden rounded-xl border border-border-light">
        <h3 className="border-b border-border-light px-4 py-3 font-medium text-text-primary">
          {localize('com_ui_knowledge_sources')}
        </h3>
        {(mutations.sync.isError || mutations.remove.isError) && (
          <p role="alert" className="px-4 py-2 text-sm text-text-destructive">
            {localize('com_ui_knowledge_source_action_error')}
          </p>
        )}
        {sources.map((source) => (
          <div
            key={source._id}
            className="flex items-center gap-3 border-t border-border-light px-4 py-3 first:border-0"
          >
            <Database className="size-4 shrink-0 text-text-secondary" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-text-primary">{source.name}</p>
              <p className="text-xs text-text-secondary">
                {source.type} · {source.syncStatus ?? 'idle'}
                {source.lastSyncedAt ? ` · ${new Date(source.lastSyncedAt).toLocaleString()}` : ''}
              </p>
              <p className="mt-1 text-xs text-text-secondary">
                {localize('com_ui_knowledge_source_shared_snapshot')}
              </p>
              {source.syncError && (
                <p className="mt-1 text-xs text-text-destructive">{source.syncError}</p>
              )}
            </div>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              aria-label={localize('com_ui_knowledge_source_edit', { 0: source.name })}
              onClick={() => setEditing(source)}
            >
              <Pencil className="size-4" />
            </Button>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              disabled={
                mutations.sync.isLoading ||
                source.syncStatus === 'queued' ||
                source.syncStatus === 'syncing'
              }
              aria-label={localize('com_ui_knowledge_source_sync', { 0: source.name })}
              onClick={() => mutations.sync.mutate(source._id)}
            >
              <RefreshCw
                className={
                  source.syncStatus === 'queued' || source.syncStatus === 'syncing'
                    ? 'size-4 animate-spin'
                    : 'size-4'
                }
              />
            </Button>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              disabled={mutations.remove.isLoading}
              aria-label={localize('com_ui_knowledge_source_delete', { 0: source.name })}
              onClick={() => {
                if (
                  window.confirm(
                    localize('com_ui_knowledge_source_delete_confirm', { 0: source.name }),
                  )
                ) {
                  mutations.remove.mutate(source._id);
                }
              }}
            >
              <Trash2 className="size-4" />
            </Button>
          </div>
        ))}
      </section>
      {editing && (
        <SourceEditDialog
          source={editing}
          knowledgeBaseId={knowledgeBaseId}
          onClose={() => setEditing(null)}
        />
      )}
    </>
  );
}

function SourceEditDialog({
  source,
  knowledgeBaseId,
  onClose,
}: {
  source: KnowledgeSource;
  knowledgeBaseId: string;
  onClose: () => void;
}) {
  const localize = useLocalize();
  const connectors = useKnowledgeConnectorsQuery(true);
  const mutations = useKnowledgeSourceMutations(knowledgeBaseId);
  const connector = connectors.data?.connectors.find((item) => item.type === source.type);
  const [name, setName] = useState('');
  const [values, setValues] = useState<Record<string, unknown>>({});
  useEffect(() => {
    setName(source.name);
    setValues(source.config ?? {});
  }, [source]);
  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!connector || !name.trim()) return;
    const { type: _type, ...input } = buildKnowledgeSourceInput({
      type: connector.type,
      name,
      fields: connector.fields ?? [],
      values,
    });
    mutations.update.mutate({ sourceId: source._id, input }, { onSuccess: onClose });
  };
  return (
    <OGDialog open onOpenChange={(open) => !open && onClose()}>
      <OGDialogContent className="w-11/12 max-w-2xl">
        {connectors.isLoading || !connector ? (
          <div className="flex justify-center p-8">
            <Spinner />
          </div>
        ) : (
          <form className="space-y-4 p-2" onSubmit={submit}>
            <div>
              <h2 className="text-lg font-semibold text-text-primary">
                {localize('com_ui_knowledge_source_edit', { 0: source.name })}
              </h2>
              <p className="mt-1 text-sm text-text-secondary">
                {localize('com_ui_knowledge_source_credentials_help')}
              </p>
            </div>
            <div>
              <Label htmlFor="knowledge-source-edit-name">{localize('com_ui_name')}</Label>
              <Input
                id="knowledge-source-edit-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                required
              />
            </div>
            {(connector.fields ?? []).map((field) => (
              <ConnectorField
                key={field.key}
                field={field}
                value={values[field.key]}
                onChange={(value) => setValues((current) => ({ ...current, [field.key]: value }))}
              />
            ))}
            {mutations.update.isError && (
              <p role="alert" className="text-sm text-text-destructive">
                {localize('com_ui_knowledge_source_save_error')}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={onClose}>
                {localize('com_ui_cancel')}
              </Button>
              <Button type="submit" disabled={!name.trim() || mutations.update.isLoading}>
                {localize('com_ui_save')}
              </Button>
            </div>
          </form>
        )}
      </OGDialogContent>
    </OGDialog>
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
  const filesQuery = useGetFiles<TFile[]>({ enabled: open });
  const files = filesQuery.data ?? [];
  const mutations = useKnowledgeBaseMutations();
  const linkedIds = useMemo(
    () => new Set((knowledgeBase.documents ?? []).map((document) => document.file_id)),
    [knowledgeBase.documents],
  );
  let filesContent: React.ReactNode;
  if (filesQuery.isError) {
    filesContent = <QueryError onRetry={() => void filesQuery.refetch()} />;
  } else if (filesQuery.isLoading) {
    filesContent = (
      <div className="flex justify-center p-6" aria-label={localize('com_ui_loading')}>
        <Spinner />
      </div>
    );
  } else if (files.length === 0) {
    filesContent = (
      <p className="p-6 text-center text-sm text-text-secondary">
        {localize('com_ui_knowledge_no_files')}
      </p>
    );
  } else {
    filesContent = files.map((file) => (
      <div
        key={file.file_id}
        className="flex items-center justify-between border-b border-border-light px-3 py-2 last:border-0"
      >
        <span className="min-w-0 truncate text-sm text-text-primary">{file.filename}</span>
        <Button
          size="sm"
          variant="outline"
          disabled={linkedIds.has(file.file_id) || mutations.addDocument.isLoading}
          onClick={() => mutations.addDocument.mutate({ id: knowledgeBase._id, file })}
        >
          {localize('com_ui_add')}
        </Button>
      </div>
    ));
  }
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
            {filesContent}
          </div>
        </div>
      </OGDialogContent>
    </OGDialog>
  );
}

function SourceCatalogDialog({
  open,
  knowledgeBaseId,
  onClose,
  onChooseFiles,
}: {
  open: boolean;
  knowledgeBaseId: string;
  onClose: () => void;
  onChooseFiles: () => void;
}) {
  const localize = useLocalize();
  const connectors = useKnowledgeConnectorsQuery(open);
  const mutations = useKnowledgeSourceMutations(knowledgeBaseId);
  const [selected, setSelected] = useState<KnowledgeConnector | null>(null);
  const [sourceName, setSourceName] = useState('');
  const [values, setValues] = useState<Record<string, unknown>>({});
  const advertised = connectors.data?.connectors ?? [];
  const reset = () => {
    mutations.create.reset();
    setSelected(null);
    setSourceName('');
    setValues({});
  };
  const close = () => {
    reset();
    onClose();
  };
  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!selected || !sourceName.trim()) return;
    mutations.create.mutate(
      buildKnowledgeSourceInput({
        type: selected.type,
        name: sourceName,
        fields: selected.fields ?? [],
        values,
      }),
      { onSuccess: close },
    );
  };
  let catalogContent: React.ReactNode;
  if (connectors.isLoading) {
    catalogContent = (
      <div className="flex justify-center p-8" aria-label={localize('com_ui_loading')}>
        <Spinner />
      </div>
    );
  } else if (connectors.isError) {
    catalogContent = <QueryError onRetry={() => void connectors.refetch()} />;
  } else {
    catalogContent = (
      <>
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
              key={connector.type}
              type="button"
              onClick={() => {
                setSelected(connector);
                setSourceName(connector.name);
              }}
              className="rounded-xl border border-border-light p-4 text-left hover:bg-surface-hover"
            >
              <Database className="mb-3 size-5" />
              <span className="font-medium text-text-primary">{connector.name}</span>
              {connector.setup === 'manual_credentials' && (
                <span className="ml-2 rounded bg-surface-secondary px-1.5 py-0.5 text-[10px] text-text-secondary">
                  {localize('com_ui_knowledge_manual_setup')}
                </span>
              )}
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
      </>
    );
  }
  return (
    <OGDialog open={open} onOpenChange={(next) => !next && close()}>
      <OGDialogContent className="w-11/12 max-w-2xl">
        {selected ? (
          <form className="space-y-4 p-2" onSubmit={submit}>
            <div>
              <button
                type="button"
                className="text-xs text-text-secondary hover:text-text-primary"
                onClick={reset}
              >
                ← {localize('com_ui_back')}
              </button>
              <h2 className="mt-2 text-lg font-semibold text-text-primary">{selected.name}</h2>
              {selected.description && (
                <p className="mt-1 text-sm text-text-secondary">{selected.description}</p>
              )}
              <p className="mt-2 rounded-lg bg-surface-secondary p-3 text-xs text-text-secondary">
                {localize('com_ui_knowledge_source_shared_snapshot_help')}
              </p>
            </div>
            <div>
              <Label htmlFor="knowledge-source-name">{localize('com_ui_name')}</Label>
              <Input
                id="knowledge-source-name"
                value={sourceName}
                onChange={(e) => setSourceName(e.target.value)}
                required
                autoComplete="off"
              />
            </div>
            {(selected.fields ?? []).map((field) => (
              <ConnectorField
                key={field.key}
                field={field}
                value={values[field.key]}
                onChange={(value) => setValues((current) => ({ ...current, [field.key]: value }))}
              />
            ))}
            {mutations.create.isError && (
              <p role="alert" className="text-sm text-text-destructive">
                {localize('com_ui_knowledge_source_save_error')}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={close}>
                {localize('com_ui_cancel')}
              </Button>
              <Button type="submit" disabled={!sourceName.trim() || mutations.create.isLoading}>
                {localize('com_ui_knowledge_connect')}
              </Button>
            </div>
          </form>
        ) : (
          <div className="p-2">
            <h2 className="text-lg font-semibold text-text-primary">
              {localize('com_ui_knowledge_add_source')}
            </h2>
            {catalogContent}
          </div>
        )}
      </OGDialogContent>
    </OGDialog>
  );
}

function ConnectorField({
  field,
  value,
  onChange,
}: {
  field: KnowledgeConnectorField;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  const inputId = `knowledge-source-${field.key}`;
  if (field.type === 'boolean')
    return (
      <label className="flex items-center gap-2 text-sm text-text-primary">
        <input
          id={inputId}
          type="checkbox"
          checked={value === true}
          onChange={(event) => onChange(event.target.checked)}
        />
        {field.label}
      </label>
    );
  let fieldControl: React.ReactNode;
  if (field.type === 'select') {
    fieldControl = (
      <select
        id={inputId}
        required={field.required}
        value={String(value ?? '')}
        onChange={(event) => onChange(event.target.value)}
        className="h-10 w-full rounded-lg border border-border-medium bg-surface-primary px-3 text-sm text-text-primary"
      >
        <option value="" />
        {(field.options ?? []).map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    );
  } else if (field.type === 'textarea' || field.type === 'string_array') {
    fieldControl = (
      <TextareaAutosize
        id={inputId}
        aria-label={field.label}
        required={field.required}
        value={String(value ?? '')}
        placeholder={field.placeholder}
        onChange={(event) => onChange(event.target.value)}
        minRows={field.type === 'string_array' ? 2 : 3}
        className="w-full rounded-lg border border-border-medium bg-transparent p-3 text-sm text-text-primary"
      />
    );
  } else {
    fieldControl = (
      <Input
        id={inputId}
        type={field.secret || field.type === 'password' ? 'password' : field.type}
        required={field.required}
        value={String(value ?? '')}
        placeholder={field.placeholder}
        autoComplete={field.secret || field.type === 'password' ? 'new-password' : 'off'}
        onChange={(event) =>
          onChange(
            field.type === 'number' && event.target.value !== ''
              ? Number(event.target.value)
              : event.target.value,
          )
        }
      />
    );
  }
  return (
    <div>
      <Label htmlFor={inputId}>{field.label}</Label>
      {fieldControl}
      {field.help && <p className="mt-1 text-xs text-text-secondary">{field.help}</p>}
    </div>
  );
}
