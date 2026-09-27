import { logger, SystemCapabilities } from '@librechat/data-schemas';
import type { HasCapabilityFn, HasConfigCapabilityFn } from '~/middleware/capabilities';

type RequestUser = {
  id?: string;
  _id?: { toString(): string };
  role?: string;
  tenantId?: string;
  idOnTheSource?: string | null;
};

export interface ConfigManagementAccessDeps {
  user?: RequestUser | null;
  langfuseConnectionAvailable: boolean;
  hasCapability: HasCapabilityFn;
  hasConfigCapability: HasConfigCapabilityFn;
}

export async function resolveConfigManagementAccess({
  user,
  langfuseConnectionAvailable,
  hasCapability,
  hasConfigCapability,
}: ConfigManagementAccessDeps): Promise<{
  adminAccess: boolean;
  configReloadAccess: boolean;
  langfuseConnectionAccess: boolean;
}> {
  const unavailable = {
    adminAccess: false,
    configReloadAccess: false,
    langfuseConnectionAccess: false,
  };
  const userId = user?.id ?? user?._id?.toString();
  if (!userId) {
    return unavailable;
  }

  const actor = {
    id: userId,
    role: user?.role ?? '',
    tenantId: user?.tenantId,
    idOnTheSource: user?.idOnTheSource ?? null,
  };
  try {
    if (!(await hasCapability(actor, SystemCapabilities.ACCESS_ADMIN))) {
      return unavailable;
    }
    const [configReloadAccess, langfuseConnectionAccess] = await Promise.all([
      hasConfigCapability(actor, null, 'manage'),
      langfuseConnectionAvailable ? hasConfigCapability(actor, 'langfuse') : false,
    ]);
    return { adminAccess: true, configReloadAccess, langfuseConnectionAccess };
  } catch (error) {
    logger.warn('[config] Configuration management capability check failed:', error);
    return unavailable;
  }
}
