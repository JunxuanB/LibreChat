import { SystemCapabilities } from '@librechat/data-schemas';
import { resolveConfigManagementAccess } from './access';

describe('resolveConfigManagementAccess', () => {
  const unavailable = {
    adminAccess: false,
    configReloadAccess: false,
    langfuseConnectionAccess: false,
  };

  it('advertises both controls for a delegated role with both grants', async () => {
    const hasCapability = jest.fn().mockResolvedValue(true);
    const hasConfigCapability = jest.fn().mockResolvedValue(true);
    const result = await resolveConfigManagementAccess({
      user: { id: 'delegated-1', role: 'DELEGATED_ADMIN' },
      langfuseConnectionAvailable: true,
      hasCapability,
      hasConfigCapability,
    });
    expect(result).toEqual({
      adminAccess: true,
      configReloadAccess: true,
      langfuseConnectionAccess: true,
    });
    expect(hasCapability).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'DELEGATED_ADMIN' }),
      SystemCapabilities.ACCESS_ADMIN,
    );
    expect(hasConfigCapability).toHaveBeenCalledWith(expect.any(Object), null, 'manage');
    expect(hasConfigCapability).toHaveBeenCalledWith(expect.any(Object), 'langfuse');
  });

  it('hides reload from a nominal admin without broad config manage access', async () => {
    const hasConfigCapability = jest.fn().mockResolvedValue(false);
    await expect(
      resolveConfigManagementAccess({
        user: { id: 'admin-1', role: 'ADMIN' },
        langfuseConnectionAvailable: false,
        hasCapability: jest.fn().mockResolvedValue(true),
        hasConfigCapability,
      }),
    ).resolves.toEqual({ ...unavailable, adminAccess: true });
    expect(hasConfigCapability).toHaveBeenCalledWith(expect.any(Object), null, 'manage');
  });

  it('avoids configuration grants when ACCESS_ADMIN is missing', async () => {
    const hasConfigCapability = jest.fn();
    await expect(
      resolveConfigManagementAccess({
        user: { id: 'unprivileged', role: 'ADMIN' },
        langfuseConnectionAvailable: true,
        hasCapability: jest.fn().mockResolvedValue(false),
        hasConfigCapability,
      }),
    ).resolves.toEqual(unavailable);
    expect(hasConfigCapability).not.toHaveBeenCalled();
  });

  it('fails closed when capability lookup fails', async () => {
    await expect(
      resolveConfigManagementAccess({
        user: { id: 'admin-1', role: 'ADMIN' },
        langfuseConnectionAvailable: true,
        hasCapability: jest.fn().mockResolvedValue(true),
        hasConfigCapability: jest.fn().mockRejectedValue(new Error('lookup unavailable')),
      }),
    ).resolves.toEqual(unavailable);
  });
});
