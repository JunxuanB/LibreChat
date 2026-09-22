import { useMemo, useState } from 'react';
import { Button, FilterInput, Spinner } from '@librechat/client';
import { Plus } from 'lucide-react';
import { useNavigate, useParams } from 'react-router-dom';
import { PanelContent } from '~/components/ui';
import { useGetStartupConfig, useKnowledgeBasesQuery } from '~/data-provider';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';
import { isKnowledgeBasesEnabled } from './feature';

interface KnowledgeBasesSidePanelProps {
  className?: string;
}

export default function KnowledgeBasesSidePanel({ className }: KnowledgeBasesSidePanelProps) {
  const { data: startupConfig } = useGetStartupConfig();
  const enabled = isKnowledgeBasesEnabled(startupConfig?.interface?.knowledgeBases);
  const localize = useLocalize();
  const navigate = useNavigate();
  const { knowledgeBaseId } = useParams();
  const [searchTerm, setSearchTerm] = useState('');
  const list = useKnowledgeBasesQuery(enabled);
  const bases = useMemo(() => {
    const query = searchTerm.trim().toLocaleLowerCase();
    const knowledgeBases = list.data?.knowledgeBases ?? [];
    return query
      ? knowledgeBases.filter((base) => base.name.toLocaleLowerCase().includes(query))
      : knowledgeBases;
  }, [list.data, searchTerm]);

  return (
    <div
      className={cn(
        'flex h-full w-full flex-col overflow-hidden border-r border-border-light pt-2',
        className,
      )}
    >
      <div role="search" className="flex shrink-0 items-center gap-2 px-3 pb-2">
        <FilterInput
          inputId="knowledge-bases-filter"
          label={localize('com_ui_filter_knowledge_bases_name')}
          value={searchTerm}
          onChange={(event) => setSearchTerm(event.target.value)}
          containerClassName="flex-1"
        />
        <Button
          type="button"
          variant="outline"
          size="icon"
          aria-label={localize('com_ui_knowledge_create')}
          onClick={() => navigate('/knowledge/new')}
        >
          <Plus className="size-4" aria-hidden="true" />
        </Button>
      </div>

      <PanelContent
        isLoading={list.isLoading}
        isEmpty={!list.isError && bases.length === 0}
        skeleton={
          <div className="flex justify-center p-6">
            <Spinner className="size-4" />
          </div>
        }
        empty={
          <p className="p-4 text-center text-sm text-text-secondary">
            {localize(searchTerm ? 'com_ui_knowledge_no_results' : 'com_ui_knowledge_empty')}
          </p>
        }
        className="px-3 pb-3"
      >
        {list.isError ? (
          <div className="p-4 text-center">
            <p className="text-sm text-text-secondary">{localize('com_ui_error')}</p>
            <Button
              type="button"
              className="mt-3"
              variant="outline"
              size="sm"
              onClick={() => list.refetch()}
            >
              {localize('com_ui_retry')}
            </Button>
          </div>
        ) : (
          <div className="space-y-1">
            {bases.map((base) => (
              <button
                key={base._id}
                type="button"
                aria-current={knowledgeBaseId === base._id ? 'page' : undefined}
                onClick={() => navigate(`/knowledge/${base._id}`)}
                className={cn(
                  'w-full rounded-lg px-3 py-2 text-left hover:bg-surface-hover',
                  knowledgeBaseId === base._id && 'bg-surface-active',
                )}
              >
                <span className="block truncate text-sm font-medium text-text-primary">
                  {base.name}
                </span>
                <span className="text-xs text-text-secondary">
                  {localize('com_ui_knowledge_document_count', {
                    0: String(base.documentCount ?? 0),
                  })}
                </span>
              </button>
            ))}
          </div>
        )}
      </PanelContent>
    </div>
  );
}
