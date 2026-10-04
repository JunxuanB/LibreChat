const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');

// Synthetic keys are accepted only by this isolated fixture, never by the live gateway.
const root = path.resolve(__dirname, '../../..');
const state = fs.mkdtempSync(path.join(os.tmpdir(), 'librechat-sub2api-smoke-'));
const port = Number(process.env.SUB2API_SMOKE_PORT || 3097);
const origin = `http://localhost:${port}`;
let revoked = false;
const imageMode = process.env.SUB2API_SMOKE_IMAGE === 'true';
const smokeModel = imageMode ? 'gpt-image-2.5-sunburst' : 'gpt-6.1-sol';
const png =
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAGUlEQVQokWMQCXhGEmIY1RAwGkoiwzVpAACemEoQZfDkSwAAAABJRU5ErkJggg==';
const imageRequests = [];
let lastChatBody;
const availableModels = imageMode ? [smokeModel] : ['gpt-image-2.5-sunburst', smokeModel];

const gateway = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  res.setHeader('Content-Type', 'application/json');
  if (url.pathname === '/api/v1/settings/public') {
    return res.end(
      JSON.stringify({ data: { site_name: '氛围土豆测试', site_subtitle: '本地对接验证' } }),
    );
  }
  const key = req.headers.authorization?.replace(/^Bearer /, '');
  if (!['smoke-key-a', 'smoke-key-b'].includes(key) || (revoked && key === 'smoke-key-a')) {
    res.statusCode = 401;
    return res.end(JSON.stringify({ error: { message: 'Invalid API key' } }));
  }
  if (url.pathname === '/v1/usage') return res.end('{"object":"usage"}');
  if (url.pathname === '/v1/models') {
    return res.end(
      JSON.stringify({
        object: 'list',
        data: availableModels.map((id) => ({ id, object: 'model' })),
      }),
    );
  }
  if (url.pathname === '/v1/images/generations' || url.pathname === '/v1/images/edits') {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const bytes = Buffer.concat(chunks);
    const payload = url.pathname.endsWith('/edits')
      ? await new Request('http://fixture.invalid', {
          method: 'POST',
          headers: { 'Content-Type': req.headers['content-type'] },
          body: bytes,
        }).formData()
      : JSON.parse(bytes.toString());
    assert.equal(payload instanceof FormData ? payload.get('model') : payload.model, smokeModel);
    if (payload instanceof FormData) assert.ok(payload.get('image[]').size > 0);
    imageRequests.push(url.pathname);
    return res.end(JSON.stringify({ data: [{ b64_json: png }] }));
  }
  if (url.pathname === '/v1/chat/completions') {
    assert.ok(!imageMode, 'Image model must never reach Chat Completions');
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    lastChatBody = body;
    const answer = {
      id: 'chatcmpl-smoke',
      object: 'chat.completion',
      model: smokeModel,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: '对接成功，聊天记录会保存在服务器。' },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
    };
    if (!body.stream) return res.end(JSON.stringify(answer));
    res.setHeader('Content-Type', 'text/event-stream');
    res.write(
      `data: ${JSON.stringify({
        ...answer,
        object: 'chat.completion.chunk',
        choices: [
          {
            index: 0,
            delta: { role: 'assistant', content: answer.choices[0].message.content },
            finish_reason: null,
          },
        ],
      })}\n\n`,
    );
    res.write(
      `data: ${JSON.stringify({ ...answer, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`,
    );
    return res.end('data: [DONE]\n\n');
  }
  res.statusCode = 404;
  res.end('{}');
});

async function main() {
  await new Promise((resolve) => gateway.listen(0, '127.0.0.1', resolve));
  const env = {
    ...process.env,
    SUB2API_STATE_DIR: state,
    SUB2API_URL: `http://127.0.0.1:${gateway.address().port}`,
    SUB2API_PUBLIC_URL: 'http://192.168.2.29:7777',
  };
  const init = spawnSync(process.execPath, ['deploy/sub2api/init.cjs'], {
    cwd: root,
    env,
    stdio: 'pipe',
  });
  assert.equal(init.status, 0);
  const configPath = path.join(state, 'librechat.yaml');
  const config = JSON.parse(fs.readFileSync(configPath));
  config.sub2api.validationTtlMs = 0;
  fs.writeFileSync(configPath, JSON.stringify(config));
  const secrets = Object.fromEntries(
    fs
      .readFileSync(path.join(state, 'secrets.env'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => line.split('=')),
  );
  const log = fs.openSync(path.join(state, 'server.log'), 'a');
  const backend = spawn(process.execPath, ['api/server/index.js'], {
    cwd: root,
    stdio: ['ignore', log, log],
    env: {
      ...env,
      ...secrets,
      CONFIG_PATH: configPath,
      MONGO_URI: process.env.SUB2API_SMOKE_MONGO_URI || 'mongodb://127.0.0.1:37017/sub2api-smoke',
      HOST: '127.0.0.1',
      PORT: String(port),
      NODE_ENV: 'production',
      DOMAIN_CLIENT: origin,
      DOMAIN_SERVER: origin,
      ENDPOINTS: 'custom',
      ALLOW_EMAIL_LOGIN: 'true',
      ALLOW_REGISTRATION: 'false',
      ALLOW_SOCIAL_LOGIN: 'false',
      ALLOW_PASSWORD_RESET: 'false',
      ALLOW_SHARED_LINKS: 'false',
      SEARCH: 'false',
      DEBUG_LOGGING: 'false',
      DEBUG_CONSOLE: 'false',
      AUTH_USER_CACHE_MODE: 'on',
      LOGIN_MAX: '100',
    },
  });
  console.log(`Smoke server log: ${path.join(state, 'server.log')}`);
  try {
    let ready = false;
    for (let attempt = 0; attempt < 120; attempt++) {
      if (backend.exitCode !== null)
        throw new Error(`Backend exited: ${backend.exitCode}; inspect the smoke server log`);
      try {
        const response = await fetch(`${origin}/api/config`);
        if (response.ok) {
          ready = true;
          break;
        }
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    assert.ok(ready, 'Backend did not become ready');
    const startup = await (await fetch(`${origin}/api/config`)).json();
    assert.equal(startup.appTitle, '氛围土豆测试');
    assert.equal(startup.registrationEnabled, false);
    assert.equal(startup.sub2api.enabled, true);
    assert.equal(startup.sub2api.defaultModel, 'gpt-6.1-sol');
    async function login(key) {
      const response = await fetch(`${origin}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: origin },
        body: JSON.stringify({ email: 'key@sub2api.invalid', password: key }),
      });
      assert.equal(response.status, 200, `Login failed (${response.status})`);
      const data = await response.json();
      return {
        ...data,
        cookie: response.headers
          .getSetCookie()
          .map((cookie) => cookie.split(';')[0])
          .join('; '),
      };
    }
    const first = await login('smoke-key-a');
    const second = await login('smoke-key-a');
    const other = await login('smoke-key-b');
    assert.equal(first.user.id, second.user.id);
    assert.notEqual(first.user.id, other.user.id);
    assert.equal(first.user.role, 'USER');
    const userAgent =
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
    const headers = { Authorization: `Bearer ${first.token}`, 'User-Agent': userAgent };
    const models = await (await fetch(`${origin}/api/models`, { headers })).json();
    assert.deepEqual(models.sub2api, availableModels);
    const endpoints = await (await fetch(`${origin}/api/endpoints`, { headers })).json();
    assert.deepEqual(Object.keys(endpoints), ['sub2api']);
    const mutation = await fetch(`${origin}/api/keys`, {
      method: 'PUT',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'sub2api', value: 'different-key' }),
    });
    assert.equal(mutation.status, 403);
    const body = new FormData();
    body.append('file', new Blob(['这是上传文件的内容。'], { type: 'text/plain' }), 'smoke.txt');
    body.append('endpoint', 'sub2api');
    body.append('message_file', 'true');
    body.append('file_id', randomUUID());
    body.append('model', smokeModel);
    body.append('tool_resource', 'context');
    const upload = await fetch(`${origin}/api/files`, {
      method: 'POST',
      headers: {
        ...headers,
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
      },
      body,
    });
    assert.equal(upload.status, 200, `File upload failed (${upload.status})`);
    const uploadBody = await upload.text();
    assert.ok(
      !uploadBody.startsWith('event: error') && !uploadBody.startsWith('event:error'),
      `Upload rejected: ${uploadBody}`,
    );
    const file = JSON.parse(uploadBody);
    assert.ok(file.file_id || file.file?.file_id, 'Uploaded file must have a persistent ID');
    const fileId = file.file_id || file.file.file_id;
    const downloadURL = `${origin}/api/files/download/${first.user.id}/${fileId}`;
    const download = await fetch(downloadURL, { headers });
    assert.equal(download.status, 200);
    assert.equal(await download.text(), '这是上传文件的内容。');
    const forbiddenDownload = await fetch(downloadURL, {
      headers: { Authorization: `Bearer ${other.token}`, 'User-Agent': userAgent },
    });
    assert.equal(forbiddenDownload.status, 403);
    console.log(
      'PASS: real backend Key login, repeat-device identity, Key isolation, model/provider sync, encrypted credential wiring, file upload',
    );
    if (process.env.SUB2API_SMOKE_BROWSER === 'true') {
      const { chromium } = require('playwright');
      const browser = await chromium.launch({ channel: 'chrome' });
      const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
      page.on('pageerror', (error) => console.log('BROWSER ERROR:', error.message));
      await page.goto(`${origin}/login`);
      await page.getByText('输入本站 API Key 即可开始，无需另行注册。', { exact: true }).waitFor();
      await page.screenshot({ path: path.join(state, 'mobile-login.png'), fullPage: true });
      await page.getByLabel('API Key', { exact: true }).fill('smoke-key-a');
      await page.getByRole('button', { name: '开始聊天', exact: true }).click();
      await page.waitForURL('**/c/new');
      await page.screenshot({ path: path.join(state, 'default-model.png'), fullPage: true });
      if (!imageMode) {
        await page
          .getByTestId('model-selector-button')
          .getByText('gpt-6.1-sol', { exact: true })
          .waitFor();
        await page.getByRole('combobox', { name: '推理强度' }).click();
        await page.getByRole('option', { name: '超深度', exact: true }).click();
        await page.screenshot({ path: path.join(state, 'mobile-reasoning.png'), fullPage: true });
      }
      const composer = page.getByTestId('text-input');
      await composer.fill('请确认聊天对接正常。');
      await composer.press('Enter');
      if (imageMode) {
        await page
          .getByTestId('screenshot-target')
          .getByAltText('image.png')
          .waitFor({ timeout: 30000 });
        await page.waitForFunction(() =>
          Array.from(document.querySelectorAll('img[alt="image.png"]')).some(
            (img) => img.naturalWidth > 0,
          ),
        );
        assert.deepEqual(imageRequests, ['/v1/images/generations']);
      } else {
        await page
          .getByTestId('screenshot-target')
          .getByText('对接成功，聊天记录会保存在服务器。', { exact: true })
          .waitFor({ timeout: 30000 });
      }
      if (!imageMode) {
        assert.equal(lastChatBody.model, 'gpt-6.1-sol');
        assert.equal(lastChatBody.reasoning_effort, 'ultra');
        console.log('PASS: default gpt-6.1-sol and user-selected reasoning effort reaches gateway');
      }
      const conversationURL = page.url();
      const otherHistory = await fetch(
        `${origin}/api/messages/${conversationURL.split('/').pop()}`,
        { headers: { Authorization: `Bearer ${other.token}`, 'User-Agent': userAgent } },
      );
      assert.ok(
        [403, 404].includes(otherHistory.status) ||
          (otherHistory.ok && (await otherHistory.json()).length === 0),
      );
      await page.screenshot({ path: path.join(state, 'mobile-chat.png'), fullPage: true });
      console.log(`Mobile screenshot: ${path.join(state, 'mobile-chat.png')}`);
      const desktop = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
      const secondPage = await desktop.newPage();
      await secondPage.goto(`${origin}/login`);
      await secondPage.getByLabel('API Key', { exact: true }).fill('smoke-key-a');
      await secondPage.getByRole('button', { name: '开始聊天', exact: true }).click();
      await secondPage.waitForURL('**/c/new');
      await secondPage.goto(conversationURL);
      if (imageMode) {
        await secondPage.getByTestId('screenshot-target').getByAltText('image.png').waitFor();
        await secondPage.waitForFunction(() =>
          Array.from(document.querySelectorAll('img[alt="image.png"]')).some(
            (img) => img.naturalWidth > 0,
          ),
        );
        const messages = await (
          await fetch(`${origin}/api/messages/${conversationURL.split('/').pop()}`, { headers })
        ).json();
        const savedPath = JSON.stringify(messages).match(
          /\/api\/files\/download\/[a-f0-9]{24}\/[a-f0-9-]{36}/,
        )?.[0];
        assert.ok(savedPath, 'Generated image must persist a private file link');
        const imageDownload = await fetch(`${origin}${savedPath}`, { headers });
        assert.equal(imageDownload.status, 200);
        const imageMetadata = JSON.parse(
          decodeURIComponent(imageDownload.headers.get('x-file-metadata')),
        );
        assert.ok(
          [401, 403].includes((await fetch(`${origin}${imageMetadata.filepath}`)).status),
          'Static image URL must require authentication',
        );
        assert.equal(
          (
            await fetch(`${origin}${imageMetadata.filepath}`, {
              headers: { Cookie: other.cookie, 'User-Agent': userAgent },
            })
          ).status,
          403,
        );
        assert.equal(
          (
            await fetch(`${origin}${savedPath}`, {
              headers: { Authorization: `Bearer ${other.token}`, 'User-Agent': userAgent },
            })
          ).status,
          403,
        );
        const blobURL = await secondPage
          .getByTestId('screenshot-target')
          .getByAltText('image.png')
          .getAttribute('src');
        assert.ok(blobURL.startsWith('blob:'), 'Image preview must use authenticated file bytes');
        await page
          .locator('input[type="file"]')
          .first()
          .setInputFiles({
            name: 'reference.png',
            mimeType: 'image/png',
            buffer: Buffer.from(png, 'base64'),
          });
        await page.screenshot({
          path: path.join(state, 'image-edit-composer.png'),
          fullPage: true,
        });
        await page.waitForTimeout(1500);
        await composer.fill('把参考图片改成蓝色');
        await composer.press('Enter');
        await page
          .getByTestId('screenshot-target')
          .getByAltText('image.png')
          .nth(1)
          .waitFor({ timeout: 30000 });
        assert.deepEqual(imageRequests, ['/v1/images/generations', '/v1/images/edits']);
        console.log(
          'PASS: image generation, private preview/download, same-Key restore, cross-Key denial and reference-image Edits',
        );
      } else {
        await secondPage
          .getByTestId('screenshot-target')
          .getByText('对接成功，聊天记录会保存在服务器。', { exact: true })
          .waitFor();
      }
      await secondPage.screenshot({ path: path.join(state, 'desktop-chat.png'), fullPage: true });
      console.log(
        'PASS: Chinese mobile login, streamed chat, independent desktop session restores the same conversation',
      );
      await browser.close();
    }
    revoked = true;
    const denied = await fetch(`${origin}/api/convos`, { headers });
    assert.equal(denied.status, 401);
    console.log('PASS: revoked Key loses access to saved conversations');
    if (process.env.SUB2API_SMOKE_KEEP === 'true') {
      revoked = false;
      console.log(`Preview ready: ${origin}/login (synthetic smoke-key-a / smoke-key-b)`);
      await new Promise(() => {});
    }
  } finally {
    backend.kill('SIGTERM');
    gateway.close();
  }
}

main().catch((error) => {
  console.error(error.message);
  gateway.close();
  process.exitCode = 1;
});
