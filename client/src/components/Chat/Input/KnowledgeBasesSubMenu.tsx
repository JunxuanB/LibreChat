import React, { useMemo, useState } from 'react';
import * as Ariakit from '@ariakit/react';
import { Check, ChevronRight, Database, Search } from 'lucide-react';
import { Spinner, usePopoverZIndex } from '@librechat/client';
import { useKnowledgeBasesQuery } from '~/data-provider';
import { useChatContext } from '~/Providers';
import { useLocalize } from '~/hooks';
import {
  type KnowledgeConversation,
  withKnowledgeBases,
} from '~/components/KnowledgeBases/conversation';
import { cn } from '~/utils';

type KnowledgeBasesSubMenuProps = React.HTMLAttributes<HTMLButtonElement>;

const KnowledgeBasesSubMenu = React.forwardRef<HTMLButtonElement, KnowledgeBasesSubMenuProps>(
  ({ className, ...props }, ref) => {
    const localize = useLocalize();
    const { conversation, setConversation } = useChatContext();
    const [filter, setFilter] = useState('');
    const popoverZIndex = usePopoverZIndex();
    const menuStore = Ariakit.useMenuStore({ focusLoop: true, placement: 'right' });
    const isOpen = menuStore.useState('open');
    const query = useKnowledgeBasesQuery(isOpen);
    const selected = useMemo(
      () => (conversation as KnowledgeConversation | null)?.knowledge_base_ids ?? [],
      [conversation],
    );
    const selectedSet = useMemo(() => new Set(selected), [selected]);
    const bases = useMemo(() => {
      const normalized = filter.trim().toLocaleLowerCase();
      const all = query.data?.knowledgeBases ?? [];
      return normalized.length === 0
        ? all
        : all.filter((base) => base.name.toLocaleLowerCase().includes(normalized));
    }, [filter, query.data?.knowledgeBases]);

    const update = (ids: string[]) => {
      setConversation((current) => withKnowledgeBases(current, ids));
    };

    return (
      <Ariakit.MenuProvider store={menuStore}>
        <Ariakit.MenuButton
          ref={ref}
          {...props}
          data-testid="tools-menu-knowledge-bases"
          onClick={(event: React.MouseEvent<HTMLButtonElement>) => {
            event.stopPropagation();
            menuStore.toggle();
          }}
          className={cn(
            'flex w-full cursor-pointer items-center justify-between rounded-lg p-2 hover:bg-surface-hover',
            className,
          )}
        >
          <div className="flex min-w-0 items-center gap-2">
            <Database className="icon-md flex-shrink-0 text-text-primary" aria-hidden="true" />
            <span>{localize('com_ui_knowledge_bases')}</span>
            <ChevronRight className="h-3 w-3 flex-shrink-0" aria-hidden="true" />
          </div>
          {selected.length > 0 && (
            <span className="ml-3 whitespace-nowrap text-xs text-text-secondary">
              {localize('com_ui_knowledge_bases_selected', { 0: selected.length })}
            </span>
          )}
        </Ariakit.MenuButton>

        <Ariakit.Menu
          portal={true}
          unmountOnHide={true}
          gutter={12}
          flip="left bottom-end top-end"
          aria-label={localize('com_ui_knowledge_bases')}
          style={{ zIndex: popoverZIndex + 1, pointerEvents: 'auto' }}
          className={cn(
            'animate-popover-left z-40 flex min-w-[min(280px,calc(100vw-1rem))] max-w-[min(340px,calc(100vw-1rem))] flex-col rounded-xl',
            'border border-border-light bg-presentation p-1.5 shadow-lg',
          )}
        >
          <div className="relative mb-1">
            <Search
              className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-text-secondary"
              aria-hidden="true"
            />
            <input
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              onKeyDown={(event) => event.stopPropagation()}
              placeholder={localize('com_ui_filter_knowledge_bases_name')}
              aria-label={localize('com_ui_filter_knowledge_bases_name')}
              className="h-9 w-full rounded-lg border border-border-light bg-surface-primary pl-8 pr-2 text-sm text-text-primary outline-none focus:border-border-medium"
            />
          </div>

          <div className="flex max-h-[280px] flex-col gap-1 overflow-y-auto">
            {query.isLoading && (
              <div className="flex justify-center py-5">
                <Spinner className="size-5" aria-label={localize('com_ui_loading')} />
              </div>
            )}
            {query.isError && (
              <div role="alert" className="space-y-2 px-2 py-3 text-center">
                <p className="text-sm text-text-secondary">
                  {localize('com_ui_knowledge_load_error')}
                </p>
                <button
                  type="button"
                  className="text-sm font-medium text-text-primary underline"
                  onClick={() => void query.refetch()}
                >
                  {localize('com_ui_retry')}
                </button>
              </div>
            )}
            {!query.isLoading && !query.isError && bases.length === 0 && (
              <p className="px-2 py-4 text-center text-sm text-text-secondary">
                {filter.trim()
                  ? localize('com_ui_knowledge_no_results')
                  : localize('com_ui_knowledge_empty')}
              </p>
            )}
            {bases.map((base) => {
              const checked = selectedSet.has(base._id);
              return (
                <Ariakit.MenuItemCheckbox
                  key={base._id}
                  name="knowledge-bases"
                  value={base._id}
                  checked={checked}
                  onChange={() =>
                    update(
                      checked ? selected.filter((id) => id !== base._id) : [...selected, base._id],
                    )
                  }
                  hideOnClick={false}
                  className="flex w-full cursor-pointer items-center gap-2 rounded-lg p-2 text-left hover:bg-surface-hover"
                >
                  <Database
                    className="size-4 flex-shrink-0 text-text-secondary"
                    aria-hidden="true"
                  />
                  <span className="min-w-0 flex-1 truncate text-sm text-text-primary">
                    {base.name}
                  </span>
                  {checked && <Check className="size-4 flex-shrink-0" aria-hidden="true" />}
                </Ariakit.MenuItemCheckbox>
              );
            })}
          </div>

          {selected.length > 0 && (
            <button
              type="button"
              className="mt-1 rounded-lg px-2 py-2 text-left text-sm text-text-secondary hover:bg-surface-hover hover:text-text-primary"
              onClick={() => update([])}
            >
              {localize('com_ui_knowledge_clear_selection')}
            </button>
          )}
        </Ariakit.Menu>
      </Ariakit.MenuProvider>
    );
  },
);

KnowledgeBasesSubMenu.displayName = 'KnowledgeBasesSubMenu';

export default React.memo(KnowledgeBasesSubMenu);
