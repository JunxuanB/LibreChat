import { useMemo } from 'react';
import { Check, Database } from 'lucide-react';
import { useKnowledgeBasesQuery } from '~/data-provider';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';

export default function KnowledgeBasePicker({ value, onChange, disabled = false }: { value: string[]; onChange: (ids: string[]) => void; disabled?: boolean }) {
  const localize = useLocalize();
  const query = useKnowledgeBasesQuery(!disabled);
  const selected = useMemo(() => new Set(value), [value]);
  return <div className="space-y-2" aria-label={localize('com_ui_knowledge_select')}>
    {(query.data?.knowledgeBases ?? []).map((base) => {
      const checked = selected.has(base._id);
      return <button key={base._id} type="button" disabled={disabled} aria-pressed={checked} onClick={() => onChange(checked ? value.filter((id) => id !== base._id) : [...value, base._id])} className={cn('flex w-full items-center gap-3 rounded-lg border border-border-light p-3 text-left hover:bg-surface-hover', checked && 'border-border-medium bg-surface-active')}><Database className="size-4 shrink-0" /><span className="min-w-0 flex-1 truncate text-sm text-text-primary">{base.name}</span>{checked && <Check className="size-4" />}</button>;
    })}
    {!query.isLoading && (query.data?.knowledgeBases.length ?? 0) === 0 && <p className="py-3 text-center text-sm text-text-secondary">{localize('com_ui_knowledge_empty')}</p>}
  </div>;
}

