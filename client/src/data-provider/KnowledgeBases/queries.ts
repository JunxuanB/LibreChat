import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { knowledgeBaseApi } from './api';
import type { KnowledgeBaseInput } from './types';
import type { TFile } from 'librechat-data-provider';

export const knowledgeBaseKeys = {
  all: ['knowledge-bases'] as const,
  detail: (id: string) => ['knowledge-bases', id] as const,
  connectors: ['knowledge-bases', 'connectors'] as const,
};

export const useKnowledgeBasesQuery = (enabled = true) =>
  useQuery(knowledgeBaseKeys.all, knowledgeBaseApi.list, { enabled });

export const useKnowledgeBaseQuery = (id?: string, enabled = true) =>
  useQuery(knowledgeBaseKeys.detail(id ?? ''), () => knowledgeBaseApi.get(id as string), {
    enabled: enabled && !!id,
  });

export const useKnowledgeConnectorsQuery = (enabled = true) =>
  useQuery(knowledgeBaseKeys.connectors, knowledgeBaseApi.connectors, {
    enabled,
    retry: false,
  });

export function useKnowledgeBaseMutations() {
  const client = useQueryClient();
  const refresh = () => client.invalidateQueries(knowledgeBaseKeys.all);
  return {
    create: useMutation((input: KnowledgeBaseInput) => knowledgeBaseApi.create(input), {
      onSuccess: refresh,
    }),
    update: useMutation(
      ({ id, input }: { id: string; input: KnowledgeBaseInput }) =>
        knowledgeBaseApi.update(id, input),
      { onSuccess: refresh },
    ),
    remove: useMutation(knowledgeBaseApi.remove, { onSuccess: refresh }),
    addDocument: useMutation(
      ({ id, file }: { id: string; file: TFile }) => knowledgeBaseApi.addDocument(id, file),
      { onSuccess: refresh },
    ),
    removeDocument: useMutation(
      ({ id, documentId }: { id: string; documentId: string }) =>
        knowledgeBaseApi.removeDocument(id, documentId),
      { onSuccess: refresh },
    ),
  };
}
