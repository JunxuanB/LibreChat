import isEqual from 'lodash/isEqual';
import { createHash } from 'node:crypto';
import isPlainObject from 'lodash/isPlainObject';
import { logger } from '@librechat/data-schemas';
import { getMaxSubagents, setMaxSubagents } from 'librechat-data-provider';
import type {
  TCustomConfig,
  TConfigReloadResult,
  TConfigReloadSection,
} from 'librechat-data-provider';
import type { AppConfig } from '@librechat/data-schemas';
import { ConfigReloadError } from './loader';

const CONFIG_GENERATION_KEY = 'config:generation';
const PUBLISH_GENERATION_SCRIPT = `
local previous = redis.call('GET', KEYS[1])
local number = 0
if previous then
  local ok, decoded = pcall(cjson.decode, previous)
  if ok and type(decoded) == 'table' then
    number = tonumber(decoded.generation) or 0
  else
    number = tonumber(previous) or 0
  end
end
number = number + 1
redis.call('SET', KEYS[1], cjson.encode({generation = number, digest = ARGV[1]}))
return number
`;

/** Bootstrap coordination cannot read its own interval from the config it gates. One second bounds Redis reads per replica while keeping propagation responsive. */
const DEFAULT_GENERATION_POLL_MS = 1_000;

const RESTART_ONLY_PATHS = [
  'cloudfront',
  'fileStrategies',
  'fileStrategy',
  'filteredTools',
  'includedTools',
  'mcpServers',
  'memory',
  'rateLimits',
  'secureImageLinks',
  'endpoints.agents.backgroundTasks',
  'endpoints.agents.eventDriven',
  'endpoints.agents.toolApproval',
  'registration.openidDiscovery',
  'registration.oauthStateTtlMs',
  'registration.socialLogins',
  'interface.agents',
  'interface.bookmarks',
  'interface.fileCitations',
  'interface.fileSearch',
  'interface.marketplace',
  'interface.mcpServers',
  'interface.memories',
  'interface.multiConvo',
  'interface.peoplePicker',
  'interface.prompts',
  'interface.remoteAgents',
  'interface.runCode',
  'interface.schedules',
  'interface.sharedLinks',
  'interface.skills',
  'interface.temporaryChat',
  'interface.webSearch',
] as const;

export type ConfigSectionStatus = TConfigReloadSection['status'];
export type ConfigSectionReport = TConfigReloadSection;
export type ConfigReloadResult = TConfigReloadResult;

export interface ConfigGenerationStore {
  get(key: string): Promise<string | null>;
  publish(key: string, digest: string): Promise<number>;
}

export interface ConfigGenerationChange {
  readonly expectedDigest: string;
  isCurrent(): boolean;
  acknowledge(): void;
}

export interface ConfigGenerationTracker {
  readonly distributed: boolean;
  check(currentDigest?: string): Promise<ConfigGenerationChange | undefined>;
  bootstrap(): Promise<void>;
  bump(digest: string): Promise<number | undefined>;
}

export interface ConfigGenerationTrackerOptions {
  pollIntervalMs?: number;
  /** Use the deployment's existing Redis connection deadline at startup. */
  bootstrapTimeoutMs?: number;
  now?: () => number;
}

export interface ConfigReloaderDeps {
  loadConfig: (current: AppConfig) => Promise<TCustomConfig | null>;
  buildBaseConfig: (config: TCustomConfig) => Promise<AppConfig>;
  getBaseConfig: () => Promise<AppConfig>;
  replaceBaseConfig: (config: AppConfig) => Promise<AppConfig>;
  clearOverrideCache: () => Promise<void>;
  withConfigUpdate?: <T>(work: () => Promise<T>) => Promise<T>;
  generation: ConfigGenerationTracker;
}

function hasPathPrefix(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}.`);
}

function matchesAnyPath(path: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => hasPathPrefix(path, prefix));
}

function collectChangedPaths(previous: unknown, next: unknown, path: string): string[] {
  if (isEqual(previous, next)) {
    return [];
  }
  const previousIsObject = isPlainObject(previous);
  const nextIsObject = isPlainObject(next);
  if ((!previousIsObject && previous != null) || (!nextIsObject && next != null)) {
    return [path];
  }
  if (!previousIsObject && !nextIsObject) {
    return [path];
  }

  const previousObject = previousIsObject ? (previous as Record<string, unknown>) : {};
  const nextObject = nextIsObject ? (next as Record<string, unknown>) : {};
  const keys = new Set([...Object.keys(previousObject), ...Object.keys(nextObject)]);
  if (keys.size === 0) {
    return [path];
  }
  return [...keys]
    .sort()
    .flatMap((key) =>
      collectChangedPaths(previousObject[key], nextObject[key], path ? `${path}.${key}` : key),
    );
}

export function createConfigReloadReport(
  previous: TCustomConfig,
  next: TCustomConfig,
): ConfigSectionReport[] {
  const sections = new Set([...Object.keys(previous), ...Object.keys(next)]);
  return [...sections].sort().map((section) => {
    const changedPaths = collectChangedPaths(
      previous[section as keyof TCustomConfig],
      next[section as keyof TCustomConfig],
      section,
    );
    if (changedPaths.length === 0) {
      return { section, status: 'unchanged', restartRequired: false };
    }

    const restartRequiredPaths = changedPaths.filter((path) =>
      matchesAnyPath(path, RESTART_ONLY_PATHS),
    );
    const restartOnly = changedPaths.every((path) => matchesAnyPath(path, RESTART_ONLY_PATHS));
    return {
      section,
      status: restartOnly ? 'restart_required' : 'applied_live',
      restartRequired: restartRequiredPaths.length > 0,
      ...(restartRequiredPaths.length > 0 ? { restartRequiredPaths } : {}),
    };
  });
}

function canonicalConfig(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalConfig);
  }
  if (!isPlainObject(value)) {
    return value;
  }
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .filter((key) => record[key] !== undefined)
      .map((key) => [key, canonicalConfig(record[key])]),
  );
}

/** Hash the effective configuration, including secrets, without publishing its contents. */
export function hashConfig(config: TCustomConfig): string {
  // A replica restarted after publication has the new startup-only values; the
  // publisher intentionally retains its old ones until restart. Both replicas
  // must still agree on the version of the live configuration.
  const liveConfig = retainRestartOnlyConfig({}, config);
  return createHash('sha256')
    .update(JSON.stringify(canonicalConfig(liveConfig)))
    .digest('hex');
}

function readPath(root: Record<string, unknown>, parts: string[]): unknown {
  let node: unknown = root;
  for (const part of parts) {
    if (!isPlainObject(node)) {
      return undefined;
    }
    node = (node as Record<string, unknown>)[part];
  }
  return node;
}

/** The runtime and its published digest both keep startup-only settings at their original value. */
export function retainRestartOnlyConfig(
  previous: TCustomConfig | undefined,
  candidate: TCustomConfig,
): TCustomConfig {
  if (!previous) {
    return candidate;
  }
  const result = { ...candidate } as Record<string, unknown>;
  for (const path of RESTART_ONLY_PATHS) {
    const parts = path.split('.');
    const oldValue = readPath(previous as Record<string, unknown>, parts);
    let destination: Record<string, unknown> = result;
    const parents: Array<{ object: Record<string, unknown>; key: string }> = [];
    let missing = false;
    for (const part of parts.slice(0, -1)) {
      const child = destination[part];
      if (!isPlainObject(child) && oldValue === undefined) {
        missing = true;
        break;
      }
      const next = isPlainObject(child) ? { ...(child as Record<string, unknown>) } : {};
      parents.push({ object: destination, key: part });
      destination[part] = next;
      destination = next;
    }
    if (missing) {
      continue;
    }
    const leaf = parts[parts.length - 1];
    if (oldValue !== undefined) {
      destination[leaf] = oldValue;
      continue;
    }
    delete destination[leaf];
    for (
      let index = parents.length - 1;
      index >= 0 && Object.keys(destination).length === 0;
      index--
    ) {
      const { object, key } = parents[index];
      if (readPath(previous as Record<string, unknown>, parts.slice(0, index + 1)) !== undefined) {
        break;
      }
      delete object[key];
      destination = object;
    }
  }
  return result as TCustomConfig;
}

/** One atomic, single-key operation works on Redis and Redis Cluster. */
export function createRedisConfigGenerationStore(client: {
  get(key: string): Promise<string | null>;
  eval(script: string, keys: number, key: string, digest: string): Promise<unknown>;
}): ConfigGenerationStore {
  return {
    get: (key) => client.get(key),
    publish: async (key, digest) =>
      Number(await client.eval(PUBLISH_GENERATION_SCRIPT, 1, key, digest)),
  };
}

export function createConfigGenerationTracker(
  store?: ConfigGenerationStore | null,
  options: ConfigGenerationTrackerOptions = {},
): ConfigGenerationTracker {
  const pollIntervalMs = Math.max(0, options.pollIntervalMs ?? DEFAULT_GENERATION_POLL_MS);
  const now = options.now ?? Date.now;
  let seenGeneration: string | undefined;
  let bootstrapComplete = false;
  let nextPollAt = 0;
  let checkFlight: Promise<ConfigGenerationChange | undefined> | undefined;
  let readSequence = 0;

  async function readGeneration(
    currentDigest: string | undefined,
    sequence: number,
    read: Promise<string | null>,
  ): Promise<ConfigGenerationChange | undefined> {
    const generationBeforeRead = seenGeneration;
    const raw = await read;
    if (sequence !== readSequence || seenGeneration !== generationBeforeRead || raw == null) {
      return undefined;
    }
    let payload: { generation: number; digest: string };
    try {
      payload = JSON.parse(raw) as { generation: number; digest: string };
    } catch {
      return undefined;
    }
    if (!Number.isSafeInteger(payload.generation) || typeof payload.digest !== 'string') {
      return undefined;
    }
    const generation = String(payload.generation);
    if (payload.digest === currentDigest) {
      seenGeneration = generation;
      return undefined;
    }
    if (seenGeneration == null && (!bootstrapComplete || payload.digest === currentDigest)) {
      seenGeneration = generation;
      return undefined;
    }
    if (generation === seenGeneration) {
      return undefined;
    }
    const previousGeneration = seenGeneration;
    return {
      expectedDigest: payload.digest,
      isCurrent: () => seenGeneration === previousGeneration && readSequence === sequence,
      acknowledge() {
        if (seenGeneration === previousGeneration) {
          seenGeneration = generation;
        }
      },
    };
  }

  async function check(currentDigest?: string): Promise<ConfigGenerationChange | undefined> {
    if (!store) {
      return undefined;
    }
    if (checkFlight) {
      return checkFlight;
    }
    if (now() < nextPollAt) {
      return undefined;
    }
    nextPollAt = now() + pollIntervalMs;
    const sequence = ++readSequence;
    const flight = readGeneration(currentDigest, sequence, store.get(CONFIG_GENERATION_KEY));
    checkFlight = flight;
    try {
      return await flight;
    } finally {
      if (checkFlight === flight) {
        checkFlight = undefined;
      }
    }
  }

  async function bootstrap(): Promise<void> {
    if (!store) {
      return;
    }
    // Capture the persisted generation before startup reads its local source.
    // A publication during that load remains visible to the next check. If
    // Redis is offline, startup proceeds and the first recovered read becomes
    // the baseline rather than treating an old persisted digest as new work.
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        check().then(() => undefined),
        new Promise<void>((resolve) => {
          timeout = setTimeout(() => {
            readSequence += 1;
            resolve();
          }, options.bootstrapTimeoutMs ?? 1_000);
          timeout.unref?.();
        }),
      ]);
    } finally {
      bootstrapComplete = true;
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  }

  async function bump(digest: string): Promise<number | undefined> {
    if (!store) {
      return undefined;
    }
    const generation = await store.publish(CONFIG_GENERATION_KEY, digest);
    readSequence += 1;
    seenGeneration = String(generation);
    nextPollAt = now() + pollIntervalMs;
    return generation;
  }

  return { distributed: store != null, check, bootstrap, bump };
}

export function createConfigReloader(deps: ConfigReloaderDeps): () => Promise<ConfigReloadResult> {
  let reloadFlight: Promise<ConfigReloadResult> | undefined;
  let propagationPending = false;

  async function reload(): Promise<ConfigReloadResult> {
    const current = await deps.getBaseConfig();
    const previousMaxSubagents = getMaxSubagents();
    let installed = false;
    let candidate: TCustomConfig;
    let report: ConfigSectionReport[];
    let effectiveDigest: string;
    try {
      const loaded = await deps.loadConfig(current);
      if (!loaded) {
        throw new ConfigReloadError('The custom configuration could not be loaded.');
      }
      candidate = loaded;
      report = createConfigReloadReport((current.config ?? {}) as TCustomConfig, candidate);
      const configChanged = report.some((section) => section.status !== 'unchanged');
      if (!configChanged && !propagationPending) {
        return {
          scope: 'unchanged',
          distributed: deps.generation.distributed,
          sections: report,
        };
      }

      effectiveDigest = hashConfig(retainRestartOnlyConfig(current.config, candidate));
      if (configChanged) {
        const next = await deps.buildBaseConfig(retainRestartOnlyConfig(current.config, candidate));
        await deps.replaceBaseConfig(next);
        installed = true;
        await deps.clearOverrideCache();
      }
    } catch (error) {
      if (installed) {
        await deps
          .replaceBaseConfig(current)
          .catch((rollbackError) =>
            logger.error(
              '[configReload] Failed to restore the previous base config:',
              rollbackError,
            ),
          );
      }
      setMaxSubagents(previousMaxSubagents);
      throw error;
    }

    try {
      const generation = await deps.generation.bump(effectiveDigest);
      if (generation == null) {
        return { scope: 'local', distributed: false, sections: report };
      }
      propagationPending = false;
      return { scope: 'cluster', distributed: true, generation, sections: report };
    } catch (error) {
      propagationPending = true;
      logger.error('[configReload] Failed to publish the config generation:', error);
      return {
        scope: 'local',
        distributed: false,
        propagationError: 'Redis generation update failed',
        sections: report,
      };
    }
  }

  return async function reloadConfig(): Promise<ConfigReloadResult> {
    if (reloadFlight) {
      return reloadFlight;
    }
    const flight = deps.withConfigUpdate ? deps.withConfigUpdate(reload) : reload();
    reloadFlight = flight;
    try {
      return await flight;
    } finally {
      if (reloadFlight === flight) {
        reloadFlight = undefined;
      }
    }
  };
}
