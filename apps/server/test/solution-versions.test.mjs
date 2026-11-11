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

test('solution HTTP tasks survive a server restart before and after publication', { timeout: 25000 }, async t => {
  const { workspace } = await fixture(t);
  const { fork } = await import('node:child_process');
  const { once } = await import('node:events');
  const { createServer } = await import('node:http');
  const { resolve } = await import('node:path');
  let blocked = true, requests = 0;
  const provider = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    requests++;
    if (blocked) return;
    const input = JSON.parse(body);
    const planned = input.messages.some(message => message.role === 'tool');
    const delta = planned ? { content: '<!doctype html><html><body><h1>Revised lamp</h1><img src="dreamatic-image:lamp"></body></html>' } : {
      tool_calls: [{ index: 0, id: 'plan', type: 'function', function: { name: 'plan_showcase', arguments: JSON.stringify({
        heroId: 'lamp', works: [{ id: 'lamp', role: 'hero', section: 'Overview', purpose: 'Introduce the lamp' }],
        direction: 'Lead with the silhouette.',
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
});
