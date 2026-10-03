import React, { useState, useMemo } from 'react';
import { useSearchPrincipalsQuery } from 'librechat-data-provider/react-query';
import type { TPrincipal, PrincipalType, PrincipalSearchParams } from 'librechat-data-provider';
import PeoplePickerSearchItem from './PeoplePickerSearchItem';
import { useLocalize, useDebounce } from '~/hooks';
import { SearchPicker } from './SearchPicker';

interface UnifiedPeopleSearchProps {
  onAddPeople: (principals: TPrincipal[]) => void;
  label?: string;
  placeholder?: string;
  className?: string;
  typeFilter?: Array<PrincipalType.USER | PrincipalType.GROUP | PrincipalType.ROLE> | null;
  excludeIds?: (string | undefined)[];
}

export default function UnifiedPeopleSearch({
  onAddPeople,
  label,
  placeholder,
  className = '',
  typeFilter = null,
  excludeIds = [],
}: UnifiedPeopleSearchProps) {
  const localize = useLocalize();
  const [searchQuery, setSearchQuery] = useState('');

  const debouncedQuery = useDebounce(searchQuery, 300);

  const searchParams: PrincipalSearchParams = useMemo(
    () => ({
      q: debouncedQuery,
      limit: 30,
      ...(typeFilter && typeFilter.length > 0 && { types: typeFilter }),
    }),
    [debouncedQuery, typeFilter],
  );

  const {
    data: searchResponse,
    isLoading: queryIsLoading,
    error,
  } = useSearchPrincipalsQuery(searchParams, {
    enabled: debouncedQuery.length >= 2,
  });

  const isLoading = searchQuery.length >= 2 && (searchQuery !== debouncedQuery || queryIsLoading);

  const selectableResults = useMemo(() => {
    const results = searchResponse?.results || [];

    return results.filter(
      (result) => result.idOnTheSource && !excludeIds.includes(result.idOnTheSource),
    );
  }, [searchResponse?.results, excludeIds]);

  if (error) {
    console.error('Principal search error:', error);
  }

  const handlePick = (principal: TPrincipal) => {
    // Immediately add the selected person to the unified list
    onAddPeople([principal]);
  };

  return (
    <div className={`${className}`}>
      <SearchPicker<TPrincipal & { key: string; value: string }>
        options={selectableResults.map((s) => ({
          ...s,
          id: s.id ?? undefined,
          key: s.idOnTheSource || 'unknown' + 'picker_key',
          value: s.idOnTheSource || 'Unknown',
        }))}
        renderOptions={(o) => <PeoplePickerSearchItem principal={o} />}
        placeholder={placeholder || localize('com_ui_search_default_placeholder')}
        query={searchQuery}
        onQueryChange={(query: string) => {
          setSearchQuery(query);
        }}
        onPick={handlePick}
        isLoading={isLoading}
        label={label || placeholder || localize('com_ui_search_default_placeholder')}
        labelClassName="sr-only"
      />
    </div>
  );
}
