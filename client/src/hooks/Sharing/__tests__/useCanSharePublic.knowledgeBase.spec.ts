import { renderHook } from '@testing-library/react';
import { PermissionTypes, Permissions, ResourceType } from 'librechat-data-provider';
import { useCanSharePublic } from '../useCanSharePublic';

const mockUseHasAccess = jest.fn((_args: unknown) => true);

jest.mock('~/hooks', () => ({
  useHasAccess: (args: unknown) => mockUseHasAccess(args),
}));

describe('useCanSharePublic knowledge base mapping', () => {
  it('checks the knowledge base public-sharing permission', () => {
    const { result } = renderHook(() => useCanSharePublic(ResourceType.KNOWLEDGE_BASE));

    expect(result.current).toBe(true);
    expect(mockUseHasAccess).toHaveBeenCalledWith({
      permissionType: PermissionTypes.KNOWLEDGE_BASES,
      permission: Permissions.SHARE_PUBLIC,
    });
  });
});
