import { FileSources } from 'librechat-data-provider';
import type { TCustomConfig } from 'librechat-data-provider';
import type { AppConfig } from '@librechat/data-schemas';
import {
  createConfigReloader,
  createConfigReloadReport,
  createConfigGenerationTracker,
  hashConfig,
  retainRestartOnlyConfig,
} from './reload';
import { createAppConfigService } from './service';
import { ConfigReloadError } from './loader';

class MemoryGenerationStore {
  private generation = 0;
  private digest = '';

  get = jest.fn(
    async (): Promise<string> =>
      JSON.stringify({ generation: this.generation, digest: this.digest }),
  );

  publish = jest.fn(async (_key: string, digest: string): Promise<number> => {
    this.generation += 1;
    this.digest = digest;
    return this.generation;
  });
}

function appConfig(config: TCustomConfig): AppConfig {
  return { config, endpoints: config.endpoints } as AppConfig;
}

function createReplica(
  source: { current: TCustomConfig },
  generation: ReturnType<typeof createConfigGenerationTracker>,
) {
  const entries = new Map<string, AppConfig>();
  const cache = {
    get: async (key: string) => entries.get(`APP_CONFIG:${key}`),
    set: async (key: string, value: unknown) => {
      entries.set(`APP_CONFIG:${key}`, value as AppConfig);
    },
    delete: async (key: string) => entries.delete(`APP_CONFIG:${key}`),
    opts: { store: { keys: () => entries.keys() } },
  };
  return createAppConfigService({
    loadBaseConfig: async () => appConfig(source.current),
    setCachedTools: async () => undefined,
    getCache: () => cache,
    cacheKeys: { APP_CONFIG: 'APP_CONFIG' },
    getApplicableConfigs: async () => [],
    getUserPrincipals: async () => [],
    syncConfigGeneration: generation.check,
    bootstrapConfigGeneration: generation.bootstrap,
  });
}

function customConfig(model: string): TCustomConfig {
  return {
    version: '1.2.1',
    endpoints: {
      custom: [
        {
          name: 'gateway',
          apiKey: 'user_provided',
          baseURL: 'https://example.com/v1',
          models: { default: [model], fetch: false },
        },
      ],
    },
  };
}

describe('config reload', () => {
  it('applies a custom endpoint model change on two replicas through one generation bump', async () => {
    const source = { current: customConfig('old-model') };
    const store = new MemoryGenerationStore();
    const generationA = createConfigGenerationTracker(store, { pollIntervalMs: 0 });
    const generationB = createConfigGenerationTracker(store, { pollIntervalMs: 0 });
    const replicaA = createReplica(source, generationA);
    const replicaB = createReplica(source, generationB);

    await Promise.all([
      replicaA.getAppConfig({ baseOnly: true }),
      replicaB.getAppConfig({ baseOnly: true }),
    ]);
    source.current = customConfig('new-model');

    const reload = createConfigReloader({
      loadConfig: async () => source.current,
      buildBaseConfig: async (config) => appConfig(config),
      getBaseConfig: () => replicaA.getAppConfig({ baseOnly: true }),
      replaceBaseConfig: replicaA.replaceBaseConfig,
      clearOverrideCache: () => replicaA.clearOverrideCache(),
      generation: generationA,
    });
    const result = await reload();

    await replicaB.getAppConfig({ baseOnly: true });
    await new Promise((resolve) => setImmediate(resolve));
    const [configA, configB] = await Promise.all([
      replicaA.getAppConfig({ baseOnly: true }),
      replicaB.getAppConfig({ baseOnly: true }),
    ]);
    expect(result).toMatchObject({ scope: 'cluster', distributed: true, generation: 1 });
    expect(configA.config?.endpoints?.custom?.[0].models?.default).toEqual(['new-model']);
    expect(configB.config?.endpoints?.custom?.[0].models?.default).toEqual(['new-model']);
    expect(store.publish).toHaveBeenCalledTimes(1);
  });

  it('does not acknowledge a valid but lagging replica source until it matches the published digest', async () => {
    const sourceA = { current: customConfig('old-model') };
    const sourceB = { current: customConfig('old-model') };
    const store = new MemoryGenerationStore();
    const replicaA = createReplica(
      sourceA,
      createConfigGenerationTracker(store, { pollIntervalMs: 0 }),
    );
    const replicaB = createReplica(
      sourceB,
      createConfigGenerationTracker(store, { pollIntervalMs: 0 }),
    );
    await Promise.all([
      replicaA.getAppConfig({ baseOnly: true }),
      replicaB.getAppConfig({ baseOnly: true }),
    ]);
    sourceA.current = customConfig('new-model');
    const reload = createConfigReloader({
      loadConfig: async () => sourceA.current,
      buildBaseConfig: async (config) => appConfig(config),
      getBaseConfig: () => replicaA.getAppConfig({ baseOnly: true }),
      replaceBaseConfig: replicaA.replaceBaseConfig,
      clearOverrideCache: replicaA.clearOverrideCache,
      generation: createConfigGenerationTracker(store, { pollIntervalMs: 0 }),
    });
    await reload();

    await replicaB.getAppConfig({ baseOnly: true });
    await new Promise((resolve) => setImmediate(resolve));
    expect(
      (await replicaB.getAppConfig({ baseOnly: true })).config.endpoints?.custom?.[0].models
        ?.default,
    ).toEqual(['old-model']);

    sourceB.current = customConfig('new-model');
    let observed = await replicaB.getAppConfig({ baseOnly: true });
    for (
      let attempt = 0;
      attempt < 8 && observed.config.endpoints?.custom?.[0].models?.default?.[0] !== 'new-model';
      attempt++
    ) {
      await new Promise((resolve) => setImmediate(resolve));
      observed = await replicaB.getAppConfig({ baseOnly: true });
    }
    expect(observed.config.endpoints?.custom?.[0].models?.default).toEqual(['new-model']);
  });

  it('waits for a lagging replica source while ignoring differences in restart-only settings', async () => {
    const publisherSource = {
      current: { ...customConfig('old-model'), fileStrategy: FileSources.local } as TCustomConfig,
    };
    const followerSource = {
      current: { ...customConfig('old-model'), fileStrategy: FileSources.s3 } as TCustomConfig,
    };
    const store = new MemoryGenerationStore();
    const publisherGeneration = createConfigGenerationTracker(store, { pollIntervalMs: 0 });
    const followerGeneration = createConfigGenerationTracker(store, { pollIntervalMs: 0 });
    const publisher = createReplica(publisherSource, publisherGeneration);
    const follower = createReplica(followerSource, followerGeneration);
    await Promise.all([
      publisher.getAppConfig({ baseOnly: true }),
      follower.getAppConfig({ baseOnly: true }),
    ]);
    publisherSource.current = { ...customConfig('new-model'), fileStrategy: FileSources.local };
    const reload = createConfigReloader({
      loadConfig: async () => publisherSource.current,
      buildBaseConfig: async (config) => appConfig(config),
      getBaseConfig: () => publisher.getAppConfig({ baseOnly: true }),
      replaceBaseConfig: publisher.replaceBaseConfig,
      clearOverrideCache: () => publisher.clearOverrideCache(),
      generation: publisherGeneration,
    });
    await reload();

    await follower.getAppConfig({ baseOnly: true });
    await new Promise((resolve) => setImmediate(resolve));
    expect(
      (await follower.getAppConfig({ baseOnly: true })).config?.endpoints?.custom?.[0].models
        ?.default,
    ).toEqual(['old-model']);
    followerSource.current = { ...customConfig('new-model'), fileStrategy: FileSources.s3 };
    let config = await follower.getAppConfig({ baseOnly: true });
    for (
      let attempt = 0;
      attempt < 8 && config.config?.endpoints?.custom?.[0].models?.default?.[0] !== 'new-model';
      attempt++
    ) {
      await new Promise((resolve) => setImmediate(resolve));
      config = await follower.getAppConfig({ baseOnly: true });
    }
    expect(config.config?.endpoints?.custom?.[0].models?.default).toEqual(['new-model']);
    expect(config.config?.fileStrategy).toBe(FileSources.s3);
  });

  it('rejects invalid config without changing the base config or generation', async () => {
    const replaceBaseConfig = jest.fn();
    const clearOverrideCache = jest.fn();
    const generation = {
      distributed: true,
      check: jest.fn().mockResolvedValue(undefined),
      bootstrap: jest.fn().mockResolvedValue(undefined),
      bump: jest.fn(),
    };
    const reload = createConfigReloader({
      loadConfig: jest
        .fn()
        .mockRejectedValue(
          new ConfigReloadError('Invalid custom config', undefined, [
            { code: 'custom', path: ['endpoints'], message: 'Invalid endpoints' },
          ]),
        ),
      buildBaseConfig: jest.fn(),
      getBaseConfig: jest.fn().mockResolvedValue(appConfig(customConfig('old-model'))),
      replaceBaseConfig,
      clearOverrideCache,
      generation,
    });

    await expect(reload()).rejects.toMatchObject({
      name: 'ConfigReloadError',
      validationErrors: [{ message: 'Invalid endpoints' }],
    });
    expect(replaceBaseConfig).not.toHaveBeenCalled();
    expect(clearOverrideCache).not.toHaveBeenCalled();
    expect(generation.bump).not.toHaveBeenCalled();
  });

  it('retries a failed generation bump when the local config is already current', async () => {
    let current = appConfig(customConfig('old-model'));
    const candidate = customConfig('new-model');
    const replaceBaseConfig = jest.fn(async (config: AppConfig) => {
      current = config;
      return config;
    });
    const generation = {
      distributed: true,
      check: jest.fn().mockResolvedValue(undefined),
      bootstrap: jest.fn().mockResolvedValue(undefined),
      bump: jest
        .fn()
        .mockRejectedValueOnce(new Error('Redis unavailable'))
        .mockResolvedValueOnce(1),
    };
    const reload = createConfigReloader({
      loadConfig: async () => candidate,
      buildBaseConfig: async (config) => appConfig(config),
      getBaseConfig: async () => current,
      replaceBaseConfig,
      clearOverrideCache: async () => undefined,
      generation,
    });

    await expect(reload()).resolves.toMatchObject({
      scope: 'local',
      propagationError: 'Redis generation update failed',
    });
    await expect(reload()).resolves.toMatchObject({
      scope: 'cluster',
      generation: 1,
    });
    expect(generation.bump).toHaveBeenCalledTimes(2);
    expect(replaceBaseConfig).toHaveBeenCalledTimes(1);
  });

  it('reports local-only scope when Redis is not configured', async () => {
    const previous = appConfig(customConfig('old-model'));
    const next = customConfig('new-model');
    const reload = createConfigReloader({
      loadConfig: async () => next,
      buildBaseConfig: async (config) => appConfig(config),
      getBaseConfig: async () => previous,
      replaceBaseConfig: async (config) => config,
      clearOverrideCache: async () => undefined,
      generation: createConfigGenerationTracker(),
    });

    await expect(reload()).resolves.toMatchObject({ scope: 'local', distributed: false });
  });

  it('restores the previous base when local override invalidation fails', async () => {
    const previous = appConfig(customConfig('old-model'));
    const replaceBaseConfig = jest.fn(async (config: AppConfig) => config);
    const generation = {
      distributed: true,
      check: jest.fn().mockResolvedValue(undefined),
      bootstrap: jest.fn().mockResolvedValue(undefined),
      bump: jest.fn(),
    };
    const reload = createConfigReloader({
      loadConfig: async () => customConfig('new-model'),
      buildBaseConfig: async (config) => appConfig(config),
      getBaseConfig: async () => previous,
      replaceBaseConfig,
      clearOverrideCache: jest.fn().mockRejectedValue(new Error('cache failure')),
      generation,
    });

    await expect(reload()).rejects.toThrow('cache failure');
    expect(replaceBaseConfig).toHaveBeenCalledTimes(2);
    expect(replaceBaseConfig).toHaveBeenLastCalledWith(previous);
    expect(generation.bump).not.toHaveBeenCalled();
  });

  it('keeps restart-only storage settings out of the installed config', async () => {
    const previous = appConfig({ ...customConfig('old-model'), fileStrategy: FileSources.local });
    const next: TCustomConfig = { ...customConfig('new-model'), fileStrategy: FileSources.s3 };
    const buildBaseConfig = jest.fn(async (config: TCustomConfig) => appConfig(config));
    const reload = createConfigReloader({
      loadConfig: async () => next,
      buildBaseConfig,
      getBaseConfig: async () => previous,
      replaceBaseConfig: async (config) => config,
      clearOverrideCache: async () => undefined,
      generation: createConfigGenerationTracker(),
    });

    const result = await reload();

    expect(buildBaseConfig).toHaveBeenCalledWith(
      expect.objectContaining({ fileStrategy: 'local', endpoints: next.endpoints }),
    );
    expect(result.sections).toContainEqual({
      section: 'fileStrategy',
      status: 'restart_required',
      restartRequired: true,
      restartRequiredPaths: ['fileStrategy'],
    });
    expect(result.sections).toContainEqual({
      section: 'endpoints',
      status: 'applied_live',
      restartRequired: false,
    });
  });

  it('keeps startup-only nested agent policies from becoming live', () => {
    const previous: TCustomConfig = {
      version: '1.0',
      endpoints: { agents: { backgroundTasks: { completionWakeups: false } } },
    };
    const next: TCustomConfig = {
      version: '1.0',
      endpoints: { agents: { backgroundTasks: { completionWakeups: true } } },
    };
    const effective = retainRestartOnlyConfig(previous, next);

    expect(effective.endpoints?.agents?.backgroundTasks?.completionWakeups).toBe(false);
    expect(createConfigReloadReport(previous, next)).toContainEqual({
      section: 'endpoints',
      status: 'restart_required',
      restartRequired: true,
      restartRequiredPaths: ['endpoints.agents.backgroundTasks.completionWakeups'],
    });
    expect(hashConfig(effective)).toBe(hashConfig(previous));
  });

  it('ignores startup-only differences in the shared digest after a replica restarts', () => {
    const live = customConfig('new-model');
    const publisher: TCustomConfig = { ...live, fileStrategy: FileSources.local };
    const restartedReplica: TCustomConfig = { ...live, fileStrategy: FileSources.s3 };
    expect(hashConfig(restartedReplica)).toBe(hashConfig(publisher));
    expect(hashConfig(customConfig('old-model'))).not.toBe(hashConfig(publisher));
  });

  it('prunes newly added restart-only parents so startup defaults remain available', () => {
    const previous: TCustomConfig = { version: '1.0' };
    const next: TCustomConfig = {
      version: '1.0',
      registration: { socialLogins: ['openid'] },
      endpoints: { agents: { backgroundTasks: { completionWakeups: false } } },
    };

    expect(retainRestartOnlyConfig(previous, next)).toEqual(previous);
    expect(hashConfig(next)).toBe(hashConfig(previous));
    expect(next.registration?.socialLogins).toEqual(['openid']);
  });

  it('pins memory policy and global static tool filters until restart', () => {
    const previous: TCustomConfig = {
      version: '1.0',
      memory: { disabled: false },
      includedTools: ['Calculator'],
      filteredTools: ['OpenWeather'],
    };
    const candidate: TCustomConfig = {
      version: '1.0',
      memory: { disabled: true },
      includedTools: ['OpenWeather'],
      filteredTools: ['Calculator'],
    };
    expect(retainRestartOnlyConfig(previous, candidate)).toEqual(previous);
    for (const section of ['memory', 'includedTools', 'filteredTools']) {
      expect(createConfigReloadReport(previous, candidate)).toContainEqual({
        section,
        status: 'restart_required',
        restartRequired: true,
        restartRequiredPaths: [section === 'memory' ? 'memory.disabled' : section],
      });
    }
    expect(hashConfig(candidate)).toBe(hashConfig(previous));
  });

  it('treats a missing versus empty config section as a live change', async () => {
    const previous: TCustomConfig = { version: '1.0' };
    const candidate: TCustomConfig = { version: '1.0', ocr: {} };
    expect(createConfigReloadReport(previous, candidate)).toContainEqual({
      section: 'ocr',
      status: 'applied_live',
      restartRequired: false,
    });
    expect(createConfigReloadReport(candidate, previous)).toContainEqual({
      section: 'ocr',
      status: 'applied_live',
      restartRequired: false,
    });

    const buildBaseConfig = jest.fn(async (source: TCustomConfig) => appConfig(source));
    const reload = createConfigReloader({
      loadConfig: async () => candidate,
      buildBaseConfig,
      getBaseConfig: async () => appConfig(previous),
      replaceBaseConfig: async (next) => next,
      clearOverrideCache: async () => undefined,
      generation: createConfigGenerationTracker(),
    });
    await expect(reload()).resolves.toMatchObject({ scope: 'local' });
    expect(buildBaseConfig).toHaveBeenCalledWith(candidate);
  });

  it('flags an MCP server edit as restart-required', () => {
    const previous: TCustomConfig = {
      version: '1.2.1',
      mcpServers: { docs: { type: 'streamable-http', url: 'https://old.example.com/mcp' } },
    };
    const next: TCustomConfig = {
      version: '1.2.1',
      mcpServers: { docs: { type: 'streamable-http', url: 'https://new.example.com/mcp' } },
    };

    expect(createConfigReloadReport(previous, next)).toContainEqual({
      section: 'mcpServers',
      status: 'restart_required',
      restartRequired: true,
      restartRequiredPaths: ['mcpServers.docs.url'],
    });
  });

  it('baselines a persisted generation before startup and detects later publications', async () => {
    const store = new MemoryGenerationStore();
    const previous = hashConfig(customConfig('older-file'));
    const next = hashConfig(customConfig('newer-file'));
    await store.publish('config:generation', previous);
    const tracker = createConfigGenerationTracker(store, { pollIntervalMs: 0 });

    await tracker.bootstrap();
    expect(await tracker.check(next)).toBeUndefined();
    await store.publish('config:generation', next);
    const change = await tracker.check(previous);
    expect(change?.expectedDigest).toBe(next);
  });

  it('bounds startup baselining when Redis is offline and baselines after recovery', async () => {
    jest.useFakeTimers();
    try {
      const store = new MemoryGenerationStore();
      await store.publish('config:generation', 'stale');
      let resolveRead: ((value: string) => void) | undefined;
      store.get.mockImplementationOnce(
        () =>
          new Promise<string>((resolve) => {
            resolveRead = resolve;
          }),
      );
      const tracker = createConfigGenerationTracker(store, {
        pollIntervalMs: 0,
        bootstrapTimeoutMs: 250,
      });
      const startup = tracker.bootstrap();
      await jest.advanceTimersByTimeAsync(250);
      await expect(startup).resolves.toBeUndefined();
      resolveRead?.(JSON.stringify({ generation: 1, digest: 'stale' }));
      await Promise.resolve();
      await Promise.resolve();
      await expect(tracker.check('current')).resolves.toMatchObject({ expectedDigest: 'stale' });
      await store.publish('config:generation', 'next');
      await expect(tracker.check('current')).resolves.toMatchObject({ expectedDigest: 'next' });
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not baseline a new publication after startup when the bootstrap read timed out', async () => {
    jest.useFakeTimers();
    try {
      const store = new MemoryGenerationStore();
      let resolveBootstrap: ((value: string) => void) | undefined;
      store.get.mockImplementationOnce(
        () =>
          new Promise<string>((resolve) => {
            resolveBootstrap = resolve;
          }),
      );
      const tracker = createConfigGenerationTracker(store, {
        pollIntervalMs: 0,
        bootstrapTimeoutMs: 100,
      });
      const startup = tracker.bootstrap();
      await jest.advanceTimersByTimeAsync(100);
      await startup;
      await store.publish('config:generation', 'new-digest');
      resolveBootstrap?.(JSON.stringify({ generation: 0, digest: 'stale' }));
      await Promise.resolve();
      await Promise.resolve();

      const changed = await tracker.check('startup-digest');
      expect(changed?.expectedDigest).toBe('new-digest');
      expect((await tracker.check('startup-digest'))?.expectedDigest).toBe('new-digest');
      changed?.acknowledge();
      await expect(tracker.check('new-digest')).resolves.toBeUndefined();
    } finally {
      jest.useRealTimers();
    }
  });

  it('accepts Redis reads slower than 250 ms without losing the next generation', async () => {
    const store = new MemoryGenerationStore();
    const tracker = createConfigGenerationTracker(store, { pollIntervalMs: 0 });
    await tracker.bootstrap();
    await store.publish('config:generation', hashConfig(customConfig('new-model')));
    let resolveRead: ((value: string) => void) | undefined;
    store.get.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          resolveRead = resolve;
        }),
    );
    const delayedCheck = tracker.check(hashConfig(customConfig('old-model')));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(store.get).toHaveBeenCalledTimes(2);
    resolveRead?.(await store.get());
    await expect(delayedCheck).resolves.toMatchObject({
      expectedDigest: hashConfig(customConfig('new-model')),
    });
  });

  it('does not regress its generation when an older read resolves after a bump', async () => {
    const store = new MemoryGenerationStore();
    const tracker = createConfigGenerationTracker(store, { pollIntervalMs: 0 });
    await tracker.check();
    let resolveRead: ((generation: string) => void) | undefined;
    store.get.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          resolveRead = resolve;
        }),
    );

    const staleCheck = tracker.check();
    await tracker.bump(hashConfig(customConfig('new-model')));
    resolveRead?.(JSON.stringify({ generation: 0, digest: hashConfig(customConfig('old-model')) }));

    await expect(staleCheck).resolves.toBeUndefined();
    await expect(tracker.check()).resolves.toBeUndefined();
  });

  it('retries a generation until a successful reload acknowledges it', async () => {
    const store = new MemoryGenerationStore();
    const tracker = createConfigGenerationTracker(store, { pollIntervalMs: 0 });
    await tracker.check();
    await store.publish('config:generation', hashConfig(customConfig('new-model')));

    const failedAttempt = await tracker.check();
    const retry = await tracker.check();
    expect(failedAttempt).toBeDefined();
    expect(retry).toBeDefined();

    retry?.acknowledge();
    await expect(tracker.check()).resolves.toBeUndefined();
  });

  it('single-flights concurrent generation reads', async () => {
    const store = new MemoryGenerationStore();
    const tracker = createConfigGenerationTracker(store, { pollIntervalMs: 0 });

    await Promise.all([tracker.check(), tracker.check(), tracker.check()]);

    expect(store.get).toHaveBeenCalledTimes(1);
  });

  it('keeps an offline Redis read single-flight and accepts it after recovery', async () => {
    let resolveRead: ((value: string) => void) | undefined;
    const store = new MemoryGenerationStore();
    const tracker = createConfigGenerationTracker(store, { pollIntervalMs: 0 });
    await tracker.bootstrap();
    store.get.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          resolveRead = resolve;
        }),
    );
    const pending = tracker.check('old');
    const joined = tracker.check('old');
    expect(store.get).toHaveBeenCalledTimes(2);
    resolveRead?.(JSON.stringify({ generation: 1, digest: 'new' }));
    await expect(Promise.all([pending, joined])).resolves.toEqual([
      expect.objectContaining({ expectedDigest: 'new' }),
      expect.objectContaining({ expectedDigest: 'new' }),
    ]);
    expect(store.get).toHaveBeenCalledTimes(2);
  });

  it('limits generation reads to one per poll interval', async () => {
    const store = new MemoryGenerationStore();
    let now = 1_000;
    const tracker = createConfigGenerationTracker(store, {
      pollIntervalMs: 1_000,
      now: () => now,
    });

    await tracker.check();
    await tracker.check();
    expect(store.get).toHaveBeenCalledTimes(1);

    now += 1_000;
    await tracker.check();
    expect(store.get).toHaveBeenCalledTimes(2);
  });
});
