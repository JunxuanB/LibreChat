import { useState } from 'react';
import { BookOpen, Plus, X } from 'lucide-react';
import { Button } from '@librechat/client';
import { useFormContext, useWatch } from 'react-hook-form';
import type { AgentForm } from '~/common';
import { KnowledgeBaseSelectDialog, isKnowledgeBasesEnabled } from '~/components/KnowledgeBases';
import { useGetStartupConfig, useKnowledgeBasesQuery } from '~/data-provider';
import { useLocalize } from '~/hooks';

export default function AgentKnowledgeBases() {
  const [open, setOpen] = useState(false);
  const localize = useLocalize();
  const { control, setValue } = useFormContext<AgentForm>();
  const { data: startupConfig } = useGetStartupConfig();
  const enabled = isKnowledgeBasesEnabled(startupConfig?.interface?.knowledgeBases);
  const selected = useWatch({ control, name: 'knowledge_base_ids' }) ?? [];
  const query = useKnowledgeBasesQuery(enabled);
  const selectedBases = (query.data?.knowledgeBases ?? []).filter((base) =>
    selected.includes(base._id),
  );
  if (!enabled) return null;
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
      {selectedBases.length === 0 ? (
        <p className="mt-2 text-xs text-text-secondary">
          {localize('com_ui_knowledge_agent_empty')}
        </p>
      ) : (
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
      )}
      <KnowledgeBaseSelectDialog
        open={open}
        onOpenChange={setOpen}
        value={selected}
        onChange={(ids) => setValue('knowledge_base_ids', ids, { shouldDirty: true })}
      />
    </section>
  );
}
