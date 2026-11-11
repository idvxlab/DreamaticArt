import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { showcaseDirectionMarkdown } from '../dist/showcase.js';
import { listSolutionVersions, readSolutionFile } from '../dist/solution-versions.js';

const digest = value => createHash('sha256').update(value).digest('hex');

async function fixture(t, exhibition = 'original') {
  const workspace = await mkdtemp(join(tmpdir(), 'dreamatic-versions-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const root = join(workspace, 'runs', 'lamp');
  async function save(path, value) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), typeof value === 'string' ? value : JSON.stringify(value));
  }
  const html = '<html><img src="../artifacts/lamp.png"></html>';
  const design = '# Lamp\n\n## Image: lamp\n### Prompt\nA lamp\n### Size\n1024x1024\n';
  const image = { path: 'artifacts/lamp.png', digest: digest('image') };
  const direction = {
    heroId: 'lamp',
    works: [{ id: 'lamp', role: 'hero', section: 'Overview', purpose: 'Introduce the lamp' }],
    markdown: 'Show the silhouette first.'
  };
  const markdown = showcaseDirectionMarkdown(direction);
  await save('artifacts/lamp.png', 'image');
  await save('artifacts/artifact-manifest.json', {
    presentation: { mode: 'gallery' },
    artifacts: [{ deliverableId: 'lamp', ...image }],
    showcase: { heroId: direction.heroId, works: direction.works, direction: 'showcase.md' }
  });
  await save('final/00-index.html', html);
  await save('design.md', design);
  if (exhibition === 'original') await save('showcase.md', markdown);
  if (exhibition !== 'missing') {
    await save('.showcase-direction.json', { fingerprint: 'builder', direction, assets: { lamp: image } });
    await save('pipeline-state.json', { completed: { builder: `v2:${digest('builder' + html)}` } });
  }
  await save('run-state.json', { status: 'completed', stages: { build: 'completed' } });
  return { workspace, root, save, markdown };
}

test('completed deliveries import once and remain readable after the source changes', async t => {
  const { workspace, save, markdown } = await fixture(t);
  const results = await Promise.all(Array.from({ length: 3 }, () => listSolutionVersions(workspace, 'lamp')));
  assert.ok(results.every(versions => versions.length === 1));
  const [version] = results[0];
  assert.equal(version.exhibitionStatus, 'original');
  await save('showcase.md', 'A later draft');
  await save('artifacts/lamp.png', 'new image');
  const read = path => readSolutionFile(workspace, 'lamp', version.id, path);
  assert.equal((await read('showcase.md')).bytes.toString(), markdown);
  assert.equal((await read('artifacts/lamp.png')).bytes.toString(), 'image');
  await assert.rejects(read('../brief.json'), /Unknown version file/);
});

test('a missing exhibition document can be recovered only from a matching delivery checkpoint', async t => {
  for (const expected of ['recovered', 'missing']) {
    const { workspace, markdown } = await fixture(t, expected);
    const [version] = await listSolutionVersions(workspace, 'lamp');
    assert.equal(version.exhibitionStatus, expected);
    if (expected === 'recovered') {
      assert.equal((await readSolutionFile(workspace, 'lamp', version.id, 'showcase.md')).bytes.toString(), markdown);
    } else {
      await assert.rejects(readSolutionFile(workspace, 'lamp', version.id, 'showcase.md'), /Unknown version file/);
    }
  }
});

test('file access rejects a snapshot symlink that escapes the version directory', async t => {
  const { workspace, root } = await fixture(t);
  const [version] = await listSolutionVersions(workspace, 'lamp');
  const path = join(root, 'solution-versions', version.id, 'design.md');
  await rm(path);
  await symlink(join(root, 'design.md'), path);
  await assert.rejects(readSolutionFile(workspace, 'lamp', version.id, 'design.md'));
});

test('static historical galleries with verified images can import without a curation manifest', async t => {
  const { workspace, save } = await fixture(t, 'missing');
  await save('artifacts/artifact-manifest.json', {
    presentation: { mode: 'gallery' },
    artifacts: [{ deliverableId: 'lamp', path: 'artifacts/lamp.png', digest: digest('image') }]
  });
  const [version] = await listSolutionVersions(workspace, 'lamp');
  assert.equal(version.exhibitionStatus, 'missing');
  assert.equal(version.coverPath, 'artifacts/lamp.png');
  assert.match((await readSolutionFile(workspace, 'lamp', version.id, version.showcasePath)).bytes.toString(), /lamp\.png/);
});

test('solution HTTP tasks survive restart and publish integrated or replaced materials', { timeout: 30000 }, async t => {
  const { workspace, root } = await fixture(t);
  const media = join(root, 'inputs', 'user-assets');
  await mkdir(media, { recursive: true });
  const photo = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
  await writeFile(join(media, 'detail.png'), photo);
  await writeFile(join(media, 'replacement.png'), photo);
  const { browserExecutable } = await import('../../../scripts/browser-executable.mjs');
  const executablePath = await browserExecutable();
  let browser, video = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4]);
  if (executablePath) {
    const { chromium } = await import('playwright-core');
    browser = await chromium.launch({ executablePath, headless: true });
    t.after(() => browser.close());
    const page = await browser.newPage();
    video = Buffer.from(await page.evaluate(async () => {
      const canvas = document.createElement('canvas');
      canvas.width = 32; canvas.height = 32;
      const context = canvas.getContext('2d');
      const stream = canvas.captureStream(12);
      const recorder = new MediaRecorder(stream, { mimeType: 'video/webm' });
      const chunks = [];
      recorder.ondataavailable = event => chunks.push(event.data);
      const ended = new Promise(resolve => { recorder.onstop = resolve; });
      recorder.start();
      context.fillRect(0, 0, 16, 16);
      await new Promise(resolve => setTimeout(resolve, 180));
      context.fillRect(16, 16, 16, 16);
      await new Promise(resolve => setTimeout(resolve, 180));
      recorder.stop();
      await ended;
      stream.getTracks().forEach(track => track.stop());
      return [...new Uint8Array(await new Blob(chunks).arrayBuffer())];
    }));
    await page.close();
  }
  await writeFile(join(media, 'clip.webm'), video);
  const { fork } = await import('node:child_process');
  const { once } = await import('node:events');
  const { createServer } = await import('node:http');
  const { resolve } = await import('node:path');
  let blocked = true, requests = 0;
  const inventories = [];
  const provider = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    requests++;
    if (blocked) return;
    const input = JSON.parse(body);
    const results = input.messages.filter(message => message.role === 'tool');
    const planned = results.some(message => JSON.stringify(message.content).includes('Exhibition direction saved'));
    const content = input.messages.find(message => message.role === 'user').content;
    const prompt = typeof content === 'string' ? content : content.find(block => block.type === 'text').text;
    const material = prompt.split('\n')[1]?.startsWith('{') ? JSON.parse(prompt.split('\n')[1]) : undefined;
    const design = prompt.split('Design document:\n')[1]?.split('\n\nPrevious exhibition direction:')[0] ?? '';
    const images = [...design.matchAll(/^## Image: ([a-zA-Z0-9_-]+)/gm)].map(match => match[1]);
    const videos = [...(design.split('## Showcase videos')[1] ?? '').matchAll(/^- ([a-zA-Z0-9_-]+):/gm)].map(match => match[1]);
    const works = [...images, ...videos].map(id => ({ id, role: id === 'lamp' ? 'hero' : 'detail', section: material?.requestedSection ?? 'Overview', purpose: 'Introduce the lamp' }));
    if (!results.length) {
      const inventory = prompt.match(/^REQUIRED WORK INVENTORY[^\n]*\n([^\n]+)/m);
      if (inventory) inventories.push(JSON.parse(inventory[1]));
    }
    const omitted = material?.operation === 'integrate' ? ['lamp', material.materialIds[0]][results.length] : undefined;
    const elements = images.map(id => `<img src="dreamatic-image:${id}">`).concat(videos.map(id => `<video controls preload="metadata" src="dreamatic-image:${id}"></video>`));
    const delta = planned ? { content: `<!doctype html><html><body><h1>Revised lamp</h1>${elements.join('')}</body></html>` } : {
      tool_calls: [{ index: 0, id: `plan-${results.length}`, type: 'function', function: { name: 'plan_showcase', arguments: JSON.stringify({
        heroId: 'lamp', works: works.filter(work => work.id !== omitted), direction: 'Lead with the silhouette.',
      }) } }]
    };
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const base = { id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture' };
    response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: 'assistant', ...delta }, finish_reason: null }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: planned ? 'stop' : 'tool_calls' }] })}\n\n`);
    response.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  t.after(() => { provider.closeAllConnections(); return new Promise(resolve => provider.close(resolve)); });
  let child, origin;
  async function stop(signal = 'SIGKILL') {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit');
    child.kill(signal);
    await exited;
  }
  t.after(() => stop());
  async function boot() {
    child = fork(resolve('apps/server/dist/index.js'), [], {
      env: {
        ...process.env, DREAMATIC_CONFIG_DIR: workspace, DREAMATIC_WORKSPACE: workspace, DREAMATIC_DESKTOP: '1',
        PI_CODING_AGENT_DIR: join(workspace, 'pi'), DREAMATIC_BASE_URL: `http://127.0.0.1:${provider.address().port}/v1`,
        DREAMATIC_API_KEY: 'fixture', DREAMATIC_MODEL: 'fixture', DREAMATIC_CONTEXT_WINDOW: '32768',
        DREAMATIC_MAX_TOKENS: '8192', DREAMATIC_PROVIDER_TYPE: 'openai-compatible'
      },
      stdio: ['ignore', 'ignore', 'ignore', 'ipc']
    });
    const [ready] = await once(child, 'message', { signal: AbortSignal.timeout(5000) });
    origin = `http://127.0.0.1:${ready.port}/api/runs/lamp`;
  }
  async function get(path, data) {
    const response = await fetch(origin + path, { signal: AbortSignal.timeout(4000), ...(data ? {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data)
    } : {}) });
    assert.ok(response.ok, `${path} returned ${response.status}`);
    return response;
  }
  async function poll(read, accept) {
    for (let attempt = 0; attempt < 100; attempt++) {
      const value = await read();
      if (accept(value)) return value;
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    assert.fail('Solution did not reach the expected state');
  }
  const tasks = async () => (await get('/solution-tasks')).json();
  await boot();
  const [parent] = await (await get('/versions')).json();
  const task = { id: 'restart', parentIds: [parent.id], prompt: 'Lead with the silhouette', operation: 'recompose' };
  const submitted = await (await get('/solution-tasks', task)).json();
  await poll(() => requests, value => value > 0);
  const queued = await (await get('/solution-tasks', { ...task, id: 'queued' })).json();
  assert.equal(queued.status, 'waiting');
  assert.equal((await tasks()).find(task => task.id === 'queued').status, 'waiting');
  await get('/solution-tasks/queued/cancel', {});
  await poll(tasks, values => values.some(task => task.id === 'queued' && task.status === 'cancelled'));
  await stop();
  blocked = false;
  await boot();
  assert.equal((await tasks()).find(task => task.id === 'restart').status, 'interrupted');
  const retried = await (await get('/solution-tasks/restart/retry', {})).json();
  assert.equal(retried.outputId, submitted.outputId);
  await poll(tasks, values => values.some(task => task.id === 'restart' && task.status === 'succeeded'));
  await stop();
  await boot();
  assert.equal((await tasks()).find(task => task.id === 'restart').status, 'succeeded');
  const versions = await (await get('/versions')).json();
  assert.equal(versions.length, 2);
  const output = versions.find(version => version.id === submitted.outputId);
  assert.equal(output.heroId, 'lamp');
  const file = async name => (await get(`/versions/${output.id}/files/${name}`)).text();
  assert.match(await file(output.designPath), /# Lamp/);
  assert.match(await file(output.exhibitionPath), /Lead with the silhouette/);
  assert.match(await file(output.showcasePath), /Revised lamp/);
  assert.equal((await (await get('/solution-tasks/restart/retry', {})).json()).outputId, output.id);
  assert.equal((await (await get('/versions')).json()).length, 2);
  const materials = { parentIds: [parent.id], materialEdit: { mode: 'integrate', fileIds: ['inputs/user-assets/detail.png', 'inputs/user-assets/clip.webm'], section: 'Overview' } };
  const attached = await (await get('/solution-tasks', { id: 'materials', ...materials })).json();
  assert.equal(attached.materialSnapshot, undefined);
  await rm(join(media, 'detail.png'));
  const materialTask = await poll(tasks, values => values.find(entry => entry.id === 'materials' && ['succeeded', 'failed'].includes(entry.status)));
  const integrated = materialTask.find(entry => entry.id === 'materials');
  assert.equal(integrated.status, 'succeeded', integrated.error);
  const withMaterials = (await (await get('/versions')).json()).find(version => version.id === attached.outputId);
  assert.equal(withMaterials.images.length, 2);
  assert.equal(withMaterials.videos.length, 1);
  assert.ok(withMaterials.works.every(work => work.section === 'Overview'));
  const materialFile = async path => get(`/versions/${withMaterials.id}/files/${path}`);
  const newPhoto = withMaterials.images.find(entry => entry.id !== 'lamp');
  const inventory = inventories.find(entries => entries.length === 3);
  assert.deepEqual(inventory.map(({ id, status, kind }) => [id, status, kind]), [
    ['lamp', 'retained', 'image'],
    [newPhoto.id, 'added', 'image'],
    [withMaterials.videos[0].id, 'added', 'video'],
  ]);
  const plans = integrated.activity[0].events.filter(event => event.label === 'plan_showcase' && event.state !== 'started');
  assert.deepEqual(plans.map(event => event.state), ['failed', 'failed', 'completed']);
  assert.ok(plans[0].detail.includes('lamp'));
  assert.ok(plans[1].detail.includes(newPhoto.id));
  assert.equal(new Set(plans.map(event => event.callId)).size, 3);
  assert.deepEqual(Buffer.from(await (await materialFile(newPhoto.path)).arrayBuffer()), photo);
  assert.match(await (await materialFile(withMaterials.designPath)).text(), /## Showcase videos/);
  const clip = withMaterials.videos[0];
  const clipUrl = origin + `/versions/${withMaterials.id}/files/${clip.path}`;
  const ranged = await fetch(clipUrl, { headers: { Range: 'bytes=0-3' } });
  assert.equal(ranged.status, 206);
  assert.equal(ranged.headers.get('content-type'), 'video/webm');
  assert.deepEqual(Buffer.from(await ranged.arrayBuffer()), video.subarray(0, 4));
  if (browser) {
    const page = await browser.newPage();
    await page.goto(origin + `/versions/${withMaterials.id}/files/${withMaterials.showcasePath}`);
    const player = page.locator('video');
    await player.evaluate(async node => {
      await node.play();
      if (!node.videoWidth) throw new Error('Video metadata was not loaded');
    });
    await page.close();
  }

  const replaced = await (await get('/solution-tasks', { id: 'swap-material', parentIds: [withMaterials.id], materialEdit: {
    mode: 'replace', fileIds: ['inputs/user-assets/replacement.png'], targetId: 'lamp',
  } })).json();
  await poll(tasks, values => values.some(entry => entry.id === 'swap-material' && entry.status === 'succeeded'));
  const replacement = (await (await get('/versions')).json()).find(version => version.id === replaced.outputId);
  assert.equal(replacement.images.length, 2);
  assert.equal(replacement.videos[0].path, clip.path);
  assert.equal(replacement.works.find(work => work.id === 'lamp').role, 'hero');
  assert.match(await (await get(`/versions/${replacement.id}/files/design.md`)).text(), /Project material: replacement.png/);
  assert.match(await (await get(`/versions/${parent.id}/files/design.md`)).text(), /A lamp/);
  assert.deepEqual(await (await get('/final-solution')).json(), { versionId: null });
  const selected = await fetch(origin + '/final-solution', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ versionId: replacement.id }),
  });
  assert.equal(selected.status, 200);
  await stop();
  await boot();
  assert.deepEqual(await (await get('/final-solution')).json(), { versionId: replacement.id });
  const wrongType = await fetch(origin + '/solution-tasks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
    id: 'wrong-type', parentIds: [parent.id], materialEdit: { mode: 'replace', fileIds: ['inputs/user-assets/clip.webm'], targetId: 'lamp' },
  }) });
  assert.equal(wrongType.ok, false);
  assert.match(await wrongType.text(), /same type/);

});
