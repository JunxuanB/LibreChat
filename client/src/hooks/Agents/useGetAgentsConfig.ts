import { useMemo } from 'react';
import { EModelEndpoint, AgentCapabilities, agentsEndpointSchema } from 'librechat-data-provider';
import type { TAgentsEndpoint, TEndpointsConfig } from 'librechat-data-provider';
import { useGetEndpointsQuery, useGetStartupConfig } from '~/data-provider';

interface UseGetAgentsConfigOptions {
  endpointsConfig?: TEndpointsConfig;
}

export default function useGetAgentsConfig(options?: UseGetAgentsConfigOptions): {
  agentsConfig?: TAgentsEndpoint | null;
  endpointsConfig?: TEndpointsConfig | null;
} {
  const { endpointsConfig: providedConfig } = options || {};

  const { data: queriedConfig } = useGetEndpointsQuery({
    enabled: !providedConfig,
  });

  const { data: startupConfig } = useGetStartupConfig();
  const sub2apiSkillsEnabled =
    startupConfig?.sub2api?.enabled === true && startupConfig.sub2api.skillsEnabled === true;
  const endpointsConfig = providedConfig || queriedConfig;

  const agentsConfig = useMemo<TAgentsEndpoint | null>(() => {
    const config: TAgentsEndpoint | null =
      (endpointsConfig?.[EModelEndpoint.agents] as TAgentsEndpoint | null) ?? null;
    if (!config) {
      return sub2apiSkillsEnabled
        ? agentsEndpointSchema.parse({
            disableBuilder: true,
            capabilities: [AgentCapabilities.skills],
          })
        : null;
    }

    return {
      ...config,
      capabilities: Array.isArray(config.capabilities)
        ? config.capabilities.map((cap) => cap as unknown as AgentCapabilities)
        : ([] as AgentCapabilities[]),
    } as TAgentsEndpoint;
  }, [endpointsConfig, sub2apiSkillsEnabled]);

  return { agentsConfig, endpointsConfig };
}
