const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const directory = process.env.SUB2API_STATE_DIR || '/app/data/sub2api';
fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
const secretsPath = path.join(directory, 'secrets.env');
if (!fs.existsSync(secretsPath)) {
  const secrets = {
    JWT_SECRET: crypto.randomBytes(32).toString('hex'),
    JWT_REFRESH_SECRET: crypto.randomBytes(32).toString('hex'),
    CREDS_KEY: crypto.randomBytes(32).toString('hex'),
    CREDS_IV: crypto.randomBytes(16).toString('hex'),
    SUB2API_IDENTITY_SECRET: crypto.randomBytes(32).toString('hex'),
  };
  fs.writeFileSync(
    secretsPath,
    Object.entries(secrets)
      .map(([key, value]) => `${key}=${value}`)
      .join('\n') + '\n',
    { mode: 0o600, flag: 'wx' },
  );
}

const baseURL = new URL(process.env.SUB2API_URL || 'http://host.docker.internal:7777');
if (
  !['http:', 'https:'].includes(baseURL.protocol) ||
  baseURL.username ||
  baseURL.password ||
  baseURL.search ||
  baseURL.hash
) {
  throw new Error('SUB2API_URL must be an HTTP(S) server URL without credentials');
}
const siteURL = process.env.SUB2API_PUBLIC_URL || 'http://192.168.2.29:7777';
const base = baseURL.toString().replace(/\/$/, '');
const config = {
  version: '1.3.5',
  cache: true,
  secureImageLinks: true,
  sub2api: {
    enabled: true,
    skillsEnabled: true,
    baseURL: base,
    publicURL: siteURL,
    timeoutMs: 8000,
    validationTtlMs: 30000,
    settingsTtlMs: 60000,
  },
  balance: { enabled: false },
  transactions: { enabled: false },
  registration: { socialLogins: [] },
  interface: {
    customWelcome: '开始与你的 AI 对话',
    modelSelect: true,
    parameters: false,
    skills: { use: true, create: true, share: false, public: false },
    multiConvo: false,
    bookmarks: true,
    memories: false,
    presets: false,
    prompts: false,
    agents: false,
    agentBuilder: false,
    mcpServers: { use: false, create: false, share: false, public: false },
    codeEnvironments: false,
    sharedLinks: false,
    publicSharedLinks: false,
    marketplace: { use: false },
  },
  endpoints: {
    agents: { capabilities: ['skills', 'context', 'ocr'], disableBuilder: true },
    custom: [
      {
        name: 'sub2api',
        apiKey: 'user_provided',
        baseURL: `${base}/v1`,
        models: { default: [], fetch: true },
        titleConvo: false,
        summarize: false,
        modelDisplayLabel: 'AI',
        dropParams: ['user'],
      },
    ],
  },
  fileConfig: {
    serverFileSizeLimit: 25,
    fileTokenLimit: 20000,
    fileContextCharLimit: 200000,
    defaultLLMDeliveryPath: { fallback: 'text', overrides: { 'image/*': 'provider' } },
    endpoints: {
      default: { fileLimit: 5, fileSizeLimit: 25, totalSizeLimit: 50 },
      sub2api: {
        fileLimit: 5,
        fileSizeLimit: 25,
        totalSizeLimit: 50,
        textFallbackWithoutTools: true,
      },
    },
  },
};
const temporary = path.join(directory, `librechat.${process.pid}.tmp`);
fs.writeFileSync(temporary, JSON.stringify(config, null, 2), { mode: 0o600 });
fs.renameSync(temporary, path.join(directory, 'librechat.yaml'));
console.log('sub2api chat configuration ready');
