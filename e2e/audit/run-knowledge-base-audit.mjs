#!/usr/bin/env node

import { spawnSync } from 'child_process';
import path from 'path';

const root = path.resolve(import.meta.dirname, '../..');
const args = new Set(process.argv.slice(2));
const output = path.resolve(
  process.env.KB_AUDIT_DIR ?? path.join(root, '../../outputs/kb-e2e-audit'),
);
const env = {
  ...process.env,
  KB_AUDIT_DIR: output,
  E2E_BASE_URL: process.env.E2E_BASE_URL ?? 'http://127.0.0.1:32280',
  E2E_PORT: process.env.E2E_PORT ?? '32280',
  E2E_MCP_HTTP_PORT: process.env.E2E_MCP_HTTP_PORT ?? '32265',
  E2E_MCP_OAUTH_PORT: process.env.E2E_MCP_OAUTH_PORT ?? '32267',
  E2E_LABEL_PORT: process.env.E2E_LABEL_PORT ?? '32289',
  E2E_CODE_API_PORT: process.env.E2E_CODE_API_PORT ?? '32290',
  E2E_RAG_API_PORT: process.env.E2E_RAG_API_PORT ?? '32291',
  E2E_ASSISTANTS_PORT: process.env.E2E_ASSISTANTS_PORT ?? '32292',
};

function run(command, commandArgs, extraEnv = {}, cwd = root) {
  const result = spawnSync(command, commandArgs, {
    cwd,
    env: { ...env, ...extraEnv },
    stdio: 'inherit',
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

if (!args.has('--skip-build')) {
  run('npm', ['run', 'build:packages']);
  run('npm', ['run', 'build:client']);
}

if (!args.has('--skip-contracts')) {
  run('npm', [
    'test',
    '--workspace=@librechat/api',
    '--',
    '--runInBand',
    '--coverage=false',
    '--watch=false',
    'src/knowledge/connectors/connectors.spec.ts',
  ]);
  run(
    'node',
    [
      '../../node_modules/jest/bin/jest.js',
      '--config',
      'jest.config.mjs',
      '--runInBand',
      '--coverage=false',
      'src/knowledge/connectors/connectors.http.integration.test.ts',
      'src/knowledge/connectors/mcpResources.integration.test.ts',
    ],
    {},
    path.join(root, 'packages/api'),
  );
  env.KB_CONNECTOR_CONTRACTS_VERIFIED = 'true';
}

run('npx', [
  'playwright',
  'test',
  '--config=e2e/playwright.config.mock.ts',
  'knowledge-bases.audit.spec.ts',
  '--project=chromium',
]);

console.log(`Knowledge Base audit report: ${path.join(output, 'index.html')}`);
