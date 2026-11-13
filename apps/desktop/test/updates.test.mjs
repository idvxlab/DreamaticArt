import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { checkForUpdate, downloadUpdate } from '../updates.mjs';

const tag = 'v2.10.0-release';
const windowsZip = 'DreamaticArt-windows-x64-v2.10.0.zip';
const windowsExe = 'DreamaticArt-2.10.0-windows-x64-setup.exe';
const macDmg = 'DreamaticArt-2.10.0-mac-arm64.dmg';
const releaseAsset = name => ({
  name, size: 5, browser_download_url: `https://github.com/idvxlab/DreamaticArt/releases/download/${tag}/${name}`,
});
const release = (...assets) => async () => Response.json({ tag_name: tag, assets });

test('update compares numeric versions and selects only the matching platform and architecture', async () => {
  const lookup = release(...[windowsZip, macDmg].map(releaseAsset));
  assert.equal((await checkForUpdate('2.9.0', 'darwin', 'arm64', lookup)).asset.name, macDmg);
  assert.equal((await checkForUpdate('2.9.0', 'win32', 'x64', lookup)).asset.name, windowsZip);
  assert.equal((await checkForUpdate('2.9.0', 'win32', 'x64', release(releaseAsset(windowsZip), releaseAsset(windowsExe)))).asset.name, windowsExe);
  assert.equal((await checkForUpdate('2.9.0', 'win32', 'arm64', lookup)).status, 'unavailable');
  assert.equal((await checkForUpdate('2.10.0', 'darwin', 'arm64', lookup)).status, 'current');
  assert.equal((await checkForUpdate('2.11.0', 'darwin', 'arm64', lookup)).status, 'current');
  const invalid = { ...releaseAsset(macDmg), browser_download_url: 'https://example.org/installer.dmg' };
  await assert.rejects(checkForUpdate('2.9.0', 'darwin', 'arm64', release(invalid)), /invalid installer metadata/);
});

test('installer download verifies integrity, preserves existing files and cleans up a failed download', async t => {
  const downloads = await mkdtemp(join(tmpdir(), 'dreamatic-update-test-'));
  t.after(() => rm(downloads, { recursive: true, force: true }));
  const body = 'abcde';
  const digest = 'sha256:' + createHash('sha256').update(body).digest('hex');
  const asset = { name: macDmg, size: body.length, digest, url: releaseAsset(macDmg).browser_download_url };
  const existing = join(downloads, macDmg);
  await writeFile(existing, 'old installer');
  const fractions = [];
  const path = await downloadUpdate(asset, downloads, fraction => fractions.push(fraction), async () => new Response(body));
  assert.equal(await readFile(existing, 'utf8'), 'old installer');
  assert.equal(await readFile(path, 'utf8'), body);
  assert.equal(fractions.at(-1), 1);
  await assert.rejects(downloadUpdate(asset, downloads, () => {}, async () => new Response('wrong')), /checksum/);
  await assert.rejects(downloadUpdate(asset, downloads, () => {}, async () => new Response('shorter')), /size/);
  assert.equal((await readdir(downloads)).length, 2);
});
