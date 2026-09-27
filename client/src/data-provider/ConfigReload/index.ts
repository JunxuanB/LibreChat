import { useMutation, useQueryClient } from '@tanstack/react-query';
import { dataService, MutationKeys, QueryKeys } from 'librechat-data-provider';
import type { TConfigReloadResult } from 'librechat-data-provider';
import type { UseMutationResult } from '@tanstack/react-query';

export function useReloadCustomConfigMutation(): UseMutationResult<
  TConfigReloadResult,
  unknown,
  void
> {
  const queryClient = useQueryClient();
  return useMutation(() => dataService.reloadCustomConfig(), {
    mutationKey: [MutationKeys.reloadCustomConfig],
    onSuccess: () => {
      void Promise.all([
        queryClient.invalidateQueries([QueryKeys.startupConfig]),
        queryClient.invalidateQueries([QueryKeys.endpoints]),
        queryClient.invalidateQueries([QueryKeys.models]),
        queryClient.invalidateQueries([QueryKeys.tokenConfig]),
      ]);
    },
  });
}
