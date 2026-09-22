import { useState } from 'react';
import { BookOpen, Plus, X } from 'lucide-react';
import { Button, Spinner } from '@librechat/client';
import { useFormContext, useWatch } from 'react-hook-form';
import { PermissionTypes, Permissions } from 'librechat-data-provider';
import type { AgentForm } from '~/common';
import KnowledgeBaseSelectDialog from '~/components/KnowledgeBases/KnowledgeBaseSelectDialog';
import { isKnowledgeBasesEnabled } from '~/components/KnowledgeBases/feature';
import { useGetStartupConfig, useKnowledgeBasesQuery } from '~/data-provider';
import { useHasAccess, useLocalize } from '~/hooks';

export default function AgentKnowledgeBases() {
  const [open, setOpen] = useState(false);
  const localize = useLocalize();
  const { control, setValue } = useFormContext<AgentForm>();
  const { data: startupConfig } = useGetStartupConfig();
  const hasAccess = useHasAccess({
    permissionType: PermissionTypes.KNOWLEDGE_BASES,
    permission: Permissions.USE,
  });
  const enabled = hasAccess && isKnowledgeBasesEnabled(startupConfig?.interface?.knowledgeBases);
  const selected = useWatch({ control, name: 'knowledge_base_ids' }) ?? [];
  const query = useKnowledgeBasesQuery(enabled);
  const selectedBases = (query.data?.knowledgeBases ?? []).filter((base) =>
    selected.includes(base._id),
  );
  if (!enabled) return null;

  let selectionContent;
  if (query.isLoading) {
    selectionContent = <Spinner className="mx-auto mt-3" aria-label={localize('com_ui_loading')} />;
  } else if (query.isError) {
    selectionContent = (
      <div role="alert" className="mt-2 flex items-center justify-between gap-2">
        <p className="text-xs text-text-destructive">{localize('com_ui_knowledge_load_error')}</p>
        <Button type="button" size="sm" variant="ghost" onClick={() => void query.refetch()}>
          {localize('com_ui_retry')}
        </Button>
      </div>
    );
  } else if (selectedBases.length === 0) {
    selectionContent = (
      <p className="mt-2 text-xs text-text-secondary">{localize('com_ui_knowledge_agent_empty')}</p>
    );
  } else {
    selectionContent = (
      <div className="mt-2 flex flex-wrap gap-1.5">
        {selectedBases.map((base) => (
          <span
            key={base._id}
            className="inline-flex items-center gap-1 rounded-md bg-surface-secondary px-2 py-1 text-xs text-text-primary"
          >
            {base.name}
            <button
              type="button"
              aria-label={localize('com_ui_knowledge_remove', { 0: base.name })}
              onClick={() =>
                setValue(
                  'knowledge_base_ids',
                  selected.filter((id) => id !== base._id),
                  { shouldDirty: true },
                )
              }
            >
              <X className="size-3" />
            </button>
          </span>
        ))}
      </div>
    );
  }

  return (
    <section className="mb-3 rounded-lg border border-border-light p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <BookOpen className="size-4 text-text-secondary" />
          <span className="text-sm font-medium text-text-primary">
            {localize('com_ui_knowledge')}
          </span>
        </div>
        <Button type="button" size="sm" variant="outline" onClick={() => setOpen(true)}>
          <Plus className="mr-1 size-3.5" />
          {localize('com_ui_add')}
        </Button>
      </div>
      {selectionContent}
      <KnowledgeBaseSelectDialog
        open={open}
        onOpenChange={setOpen}
        value={selected}
        onChange={(ids) => setValue('knowledge_base_ids', ids, { shouldDirty: true })}
      />
    </section>
  );
}
