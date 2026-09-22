import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';

export type AuditStatus = 'PASS' | 'FAIL' | 'BLOCKED_EXTERNAL' | 'SKIPPED';

export type AuditStepDefinition = {
  id: string;
  section: string;
  title: string;
  required: boolean;
};

export type AuditStepResult = AuditStepDefinition & {
  timestamp: string;
  status: AuditStatus;
  precondition: string;
  action: string;
  assertions: string[];
  evidence: Record<string, unknown>;
  screenshot?: string;
  reason?: string;
};

export const KNOWLEDGE_AUDIT_STEPS: AuditStepDefinition[] = [
  {
    id: 'KB-UI-01',
    section: 'Library CRUD',
    title: 'Open the Knowledge side panel from the rail',
    required: true,
  },
  { id: 'KB-UI-02', section: 'Library CRUD', title: 'Create a Knowledge Base', required: true },
  {
    id: 'KB-UI-03',
    section: 'Library CRUD',
    title: 'Edit and persist the Knowledge Base',
    required: true,
  },
  {
    id: 'KB-UP-01',
    section: 'Uploads',
    title: 'Upload and attach an existing file',
    required: true,
  },
  {
    id: 'KB-UP-02',
    section: 'Uploads',
    title: 'Verify KB-scoped vector ingestion',
    required: true,
  },
  {
    id: 'KB-SRC-01',
    section: 'Sources',
    title: 'Inspect every advertised source type',
    required: true,
  },
  {
    id: 'KB-SRC-02',
    section: 'Sources',
    title: 'Create and remove a Website source',
    required: true,
  },
  { id: 'KB-SRC-03', section: 'Sources', title: 'Reject a private Website target', required: true },
  {
    id: 'KB-SRC-04',
    section: 'Sources',
    title: 'Exercise Custom API source contract',
    required: true,
  },
  {
    id: 'KB-SRC-05',
    section: 'Sources',
    title: 'Exercise External Index source contract',
    required: true,
  },
  {
    id: 'KB-CHAT-01',
    section: 'Chat',
    title: 'Quick-select multiple Knowledge Bases from Tools',
    required: true,
  },
  {
    id: 'KB-CHAT-01B',
    section: 'Chat',
    title: 'Clear the Knowledge Base quick selection',
    required: true,
  },
  {
    id: 'KB-CHAT-02',
    section: 'Chat',
    title: 'Persist selection and automatically invoke file_search',
    required: true,
  },
  {
    id: 'KB-AGENT-01',
    section: 'Agents',
    title: 'Persist a Knowledge Base on an Agent',
    required: true,
  },
  {
    id: 'KB-AGENT-02',
    section: 'Agents',
    title: 'Invoke file_search from a persistent Agent',
    required: true,
  },
  {
    id: 'KB-EPH-01',
    section: 'Agents',
    title: 'Propagate KB IDs through an ephemeral Agent',
    required: true,
  },
  {
    id: 'KB-ACL-01',
    section: 'Permissions',
    title: 'Open Knowledge Base sharing controls',
    required: true,
  },
  {
    id: 'KB-ACL-02',
    section: 'Permissions',
    title: 'Enforce a second-user ACL boundary',
    required: true,
  },
  {
    id: 'KB-SYNC-01',
    section: 'Synchronization',
    title: 'Queue sync work behind a competing lease',
    required: true,
  },
  {
    id: 'KB-ERR-01',
    section: 'Reliability',
    title: 'Render a loading failure',
    required: true,
  },
  {
    id: 'KB-ERR-02',
    section: 'Reliability',
    title: 'Retry and recover the Knowledge list',
    required: true,
  },
  {
    id: 'KB-DEL-01',
    section: 'Cleanup',
    title: 'Delete a document without deleting its upload',
    required: true,
  },
  {
    id: 'KB-DEL-02',
    section: 'Cleanup',
    title: 'Delete the Knowledge Base and owned records',
    required: true,
  },
  {
    id: 'KB-CON-GH',
    section: 'Connector contracts',
    title: 'GitHub adapter contract',
    required: false,
  },
  {
    id: 'KB-CON-GD',
    section: 'Connector contracts',
    title: 'Google Drive adapter contract',
    required: false,
  },
  {
    id: 'KB-CON-SP',
    section: 'Connector contracts',
    title: 'SharePoint adapter contract',
    required: false,
  },
  {
    id: 'KB-CON-NO',
    section: 'Connector contracts',
    title: 'Notion adapter contract',
    required: false,
  },
  {
    id: 'KB-CON-CF',
    section: 'Connector contracts',
    title: 'Confluence adapter contract',
    required: false,
  },
  {
    id: 'KB-CON-PG',
    section: 'Connector contracts',
    title: 'PostgreSQL local runtime',
    required: false,
  },
  {
    id: 'KB-CON-MCP',
    section: 'Connector contracts',
    title: 'MCP resource runtime',
    required: false,
  },
];

const SECRET_KEY = /(authorization|bearer|token|password|secret|connection.?string|encrypted)/i;

function sanitize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        SECRET_KEY.test(key) ? '[REDACTED]' : sanitize(item),
      ]),
    );
  }
  if (typeof value === 'string') {
    return value
      .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
      .replace(/postgres(?:ql)?:\/\/[^\s"']+/gi, 'postgresql://[REDACTED]');
  }
  return value;
}

const outputRoot = path.resolve(
  process.env.KB_AUDIT_DIR ?? path.join(process.cwd(), 'e2e/specs/.test-results/kb-e2e-audit'),
);
export const knowledgeAuditOutputRoot = outputRoot;
const screenshotRoot = path.join(outputRoot, 'screenshots');
const manifestPath = path.join(outputRoot, 'manifest.json');
const results: AuditStepResult[] = [];

function auditColor(id: string): [number, number, number] {
  let hash = 2166136261;
  for (const character of id) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  return [64 + (hash & 127), 64 + ((hash >>> 8) & 127), 64 + ((hash >>> 16) & 127)];
}

export function resetKnowledgeAudit() {
  fs.rmSync(outputRoot, { recursive: true, force: true });
  fs.mkdirSync(screenshotRoot, { recursive: true });
  results.length = 0;
}

function definition(id: string) {
  const item = KNOWLEDGE_AUDIT_STEPS.find((step) => step.id === id);
  if (!item) throw new Error(`Unknown Knowledge Base audit step: ${id}`);
  return item;
}

async function annotatedScreenshot(page: Page, id: string, label: string, target?: Locator) {
  const safeName = `${String(results.length + 1).padStart(2, '0')}-${id.toLowerCase()}.png`;
  const screenshotPath = path.join(screenshotRoot, safeName);
  const box = target ? await target.boundingBox().catch(() => null) : null;
  const markerColor = auditColor(id);
  await page.evaluate(
    ({ auditId, auditLabel, targetBox, color }) => {
      const rgb = `rgb(${color.join(',')})`;
      const overlay = document.createElement('div');
      overlay.id = '__kb_audit_annotation__';
      overlay.dataset.auditMarker = 'KB-AUDIT-MAGENTA';
      overlay.style.cssText = [
        'position:fixed',
        'inset:0',
        'z-index:2147483647',
        'pointer-events:none',
        `border:8px solid ${rgb}`,
        'box-sizing:border-box',
      ].join(';');
      const callout = document.createElement('div');
      callout.textContent = `${auditId} · ${auditLabel}`;
      callout.style.cssText = [
        'position:fixed',
        'left:16px',
        'bottom:16px',
        'max-width:calc(100vw - 32px)',
        'padding:10px 14px',
        'border-radius:8px',
        `background:${rgb}`,
        'color:white',
        'font:700 14px/1.3 system-ui,sans-serif',
        'box-shadow:0 2px 12px rgba(0,0,0,.35)',
      ].join(';');
      overlay.appendChild(callout);
      if (targetBox) {
        const highlight = document.createElement('div');
        highlight.style.cssText = [
          'position:fixed',
          `left:${Math.max(2, targetBox.x - 4)}px`,
          `top:${Math.max(2, targetBox.y - 4)}px`,
          `width:${targetBox.width + 8}px`,
          `height:${targetBox.height + 8}px`,
          `border:4px solid ${rgb}`,
          'border-radius:8px',
          'box-shadow:0 0 0 3px rgba(255,255,255,.9)',
        ].join(';');
        overlay.appendChild(highlight);
      }
      document.body.appendChild(overlay);
    },
    { auditId: id, auditLabel: label, targetBox: box, color: markerColor },
  );
  try {
    await page.screenshot({ path: screenshotPath, fullPage: true, animations: 'disabled' });
  } finally {
    await page
      .locator('#__kb_audit_annotation__')
      .evaluate((node) => node.remove())
      .catch(() => {});
  }
  return screenshotPath;
}

export async function recordAuditFailure(page: Page, error: unknown) {
  const produced = new Set(results.map((result) => result.id));
  const item = KNOWLEDGE_AUDIT_STEPS.find((step) => step.required && !produced.has(step.id));
  if (!item) return;
  const reason = error instanceof Error ? error.message : String(error);
  const screenshot = await annotatedScreenshot(page, item.id, `${item.title} — FAILED`).catch(
    () => undefined,
  );
  results.push({
    ...item,
    timestamp: new Date().toISOString(),
    status: 'FAIL',
    precondition: 'The preceding audit steps completed.',
    action: 'Attempt the next registered user or integration operation.',
    assertions: ['The operation was expected to satisfy its registered contract.'],
    evidence: { errorType: error instanceof Error ? error.name : typeof error },
    screenshot: screenshot ? path.relative(outputRoot, screenshot) : undefined,
    reason: String(sanitize(reason)),
  });
}

export async function recordAuditStep(
  page: Page,
  input: {
    id: string;
    precondition: string;
    action: string;
    assertions: string[];
    evidence?: Record<string, unknown>;
    target?: Locator;
  },
) {
  const item = definition(input.id);
  await test.step(`${input.id} ${item.title}`, async () => {
    expect(input.assertions.length, `${input.id} must name its assertions`).toBeGreaterThan(0);
    const screenshot = await annotatedScreenshot(page, item.id, item.title, input.target);
    results.push({
      ...item,
      timestamp: new Date().toISOString(),
      status: 'PASS',
      precondition: input.precondition,
      action: input.action,
      assertions: input.assertions,
      evidence: sanitize(input.evidence ?? {}) as Record<string, unknown>,
      screenshot: path.relative(outputRoot, screenshot),
    });
  });
}

export function recordExternalBlock(
  id: string,
  reason: string,
  evidence: Record<string, unknown> = {},
) {
  const item = definition(id);
  results.push({
    ...item,
    timestamp: new Date().toISOString(),
    status: 'BLOCKED_EXTERNAL',
    precondition: 'A disposable live account or local service must be supplied by the operator.',
    action: 'The deterministic adapter contract is delegated to the repository integration matrix.',
    assertions: ['The blocker is explicit and no live credential was fabricated.'],
    evidence: sanitize(evidence) as Record<string, unknown>,
    reason,
  });
}

export function recordSkipped(id: string, reason: string) {
  const item = definition(id);
  results.push({
    ...item,
    timestamp: new Date().toISOString(),
    status: 'SKIPPED',
    precondition: 'A preceding required capability must pass.',
    action: 'No action was taken.',
    assertions: ['The skipped dependency is named explicitly.'],
    evidence: {},
    reason,
  });
}

export function recordUnproducedSteps(reason: string) {
  const produced = new Set(results.map((result) => result.id));
  for (const step of KNOWLEDGE_AUDIT_STEPS) {
    if (!produced.has(step.id)) recordSkipped(step.id, reason);
  }
}

export async function finalizeKnowledgeAudit() {
  fs.writeFileSync(
    manifestPath,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        summary: Object.fromEntries(
          ['PASS', 'FAIL', 'BLOCKED_EXTERNAL', 'SKIPPED'].map((status) => [
            status,
            results.filter((result) => result.status === status).length,
          ]),
        ),
        steps: results,
      },
      null,
      2,
    )}\n`,
  );

  const ids = results.map((result) => result.id);
  const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
  expect(duplicates, 'audit manifest contains duplicate step IDs').toEqual([]);
  const missing = KNOWLEDGE_AUDIT_STEPS.filter((step) => !ids.includes(step.id));
  expect(missing, 'audit manifest is missing registered steps').toEqual([]);

  for (const result of results) {
    expect(result.assertions.length, `${result.id} must retain assertion evidence`).toBeGreaterThan(
      0,
    );
    if (result.status === 'PASS') {
      expect(result.screenshot, `${result.id} PASS must have a screenshot`).toBeTruthy();
      const screenshotPath = path.join(outputRoot, result.screenshot!);
      expect(fs.existsSync(screenshotPath), `${result.id} screenshot must exist`).toBeTruthy();
      const { data } = await sharp(screenshotPath)
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      const [red, green, blue] = auditColor(result.id);
      let markerPixels = 0;
      for (let index = 0; index < data.length; index += 3) {
        if (data[index] === red && data[index + 1] === green && data[index + 2] === blue)
          markerPixels++;
      }
      expect(
        markerPixels,
        `${result.id} screenshot must contain its ID-specific audit annotation`,
      ).toBeGreaterThan(100);
    }
  }

  return { manifestPath, outputRoot, results: [...results] };
}
