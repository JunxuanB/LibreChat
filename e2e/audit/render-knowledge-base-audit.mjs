#!/usr/bin/env node

import fs from 'fs';
import path from 'path';

const root = path.resolve(
  process.env.KB_AUDIT_DIR ?? path.join(process.cwd(), 'e2e/specs/.test-results/kb-e2e-audit'),
);
const manifestPath = path.join(root, 'manifest.json');
const reportPath = path.join(root, 'index.html');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

const escape = (value) =>
  String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');

const rows = manifest.steps
  .map(
    (step, index) => `
      <article id="${escape(step.id)}" class="step ${escape(step.status.toLowerCase())}">
        <header>
          <span class="number">${index + 1}</span>
          <div><div class="meta">${escape(step.section)} · ${escape(step.id)}</div><h2>${escape(step.title)}</h2></div>
          <strong class="status">${escape(step.status)}</strong>
        </header>
        <dl>
          <dt>Precondition</dt><dd>${escape(step.precondition)}</dd>
          <dt>Action</dt><dd>${escape(step.action)}</dd>
          <dt>Assertions</dt><dd><ul>${step.assertions.map((item) => `<li>${escape(item)}</li>`).join('')}</ul></dd>
          ${step.reason ? `<dt>Reason</dt><dd>${escape(step.reason)}</dd>` : ''}
          <dt>Evidence</dt><dd><pre>${escape(JSON.stringify(step.evidence, null, 2))}</pre></dd>
        </dl>
        ${step.screenshot ? `<img loading="lazy" src="${escape(step.screenshot)}" alt="Annotated evidence for ${escape(step.id)}">` : '<p class="no-shot">No screenshot: this step did not execute against a locally available dependency.</p>'}
      </article>`,
  )
  .join('\n');

const summary = Object.entries(manifest.summary)
  .map(
    ([status, count]) =>
      `<div class="summary ${escape(status.toLowerCase())}"><strong>${count}</strong><span>${escape(status)}</span></div>`,
  )
  .join('');

const matrix = manifest.steps
  .map(
    (step) =>
      `<tr><td><a href="#${escape(step.id)}">${escape(step.id)}</a></td><td>${escape(step.section)}</td><td>${escape(step.title)}</td><td><strong>${escape(step.status)}</strong></td></tr>`,
  )
  .join('');

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>LibreChat Knowledge Base E2E Audit</title>
<style>
:root{color-scheme:light dark;font-family:Inter,ui-sans-serif,system-ui,sans-serif;background:#10131a;color:#edf1f7}body{margin:0}.wrap{max-width:1120px;margin:auto;padding:32px 20px 80px}h1{font-size:34px;margin:0 0 8px}.lede,.meta{color:#aab4c3}.summaries{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:26px 0}.summary{background:#1b2230;border:1px solid #334057;border-radius:12px;padding:16px}.summary strong{display:block;font-size:28px}.summary span{font-size:12px}table{width:100%;border-collapse:collapse;background:#161c27;margin:24px 0 40px}th,td{text-align:left;padding:10px;border-bottom:1px solid #303a4e}a{color:#8ec5ff}.step{background:#161c27;border:1px solid #334057;border-left:6px solid #6b7280;border-radius:14px;margin:24px 0;overflow:hidden}.step.pass{border-left-color:#22c55e}.step.fail{border-left-color:#ef4444}.step.blocked_external{border-left-color:#f59e0b}.step.skipped{border-left-color:#94a3b8}.step header{display:flex;align-items:center;gap:14px;padding:18px 20px;border-bottom:1px solid #303a4e}.step h2{margin:3px 0 0;font-size:20px}.number{display:grid;place-items:center;background:#d946ef;color:#fff;border-radius:999px;min-width:34px;height:34px;font-weight:800}.status{margin-left:auto;font-size:13px}.step dl{display:grid;grid-template-columns:130px 1fr;gap:10px 16px;padding:18px 20px;margin:0}.step dt{font-weight:700}.step dd{margin:0}.step ul{margin:0;padding-left:20px}pre{white-space:pre-wrap;word-break:break-word;background:#0d1118;padding:12px;border-radius:8px}.step img{display:block;width:100%;border-top:1px solid #303a4e}.no-shot{padding:0 20px 20px;color:#fbbf24}@media(max-width:700px){.summaries{grid-template-columns:repeat(2,1fr)}.step dl{grid-template-columns:1fr}.matrix{overflow:auto}}
</style></head><body><main class="wrap"><h1>LibreChat Knowledge Base E2E Audit</h1>
<p class="lede">Generated ${escape(manifest.generatedAt)}. Screenshots were captured with an ID-specific colored target annotation rendered inside the browser before capture. Secret-shaped evidence is redacted.</p>
<section class="summaries">${summary}</section><div class="matrix"><table><thead><tr><th>Step</th><th>Runbook area</th><th>Contract</th><th>Result</th></tr></thead><tbody>${matrix}</tbody></table></div>
${rows}</main></body></html>`;

fs.writeFileSync(reportPath, html);
console.log(reportPath);
