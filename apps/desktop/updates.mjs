import { createHash } from 'node:crypto';
import { constants, createWriteStream } from 'node:fs';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const repository = 'https://github.com/idvxlab/DreamaticArt';
const latestRelease = 'https://api.github.com/repos/idvxlab/DreamaticArt/releases/latest';

function versionParts(value) {
  const match = typeof value === 'string' && /^v?(\d+\.\d+\.\d+)(?:-release(?:-tag)?)?$/.exec(value);
  if (!match) throw new Error('Could not read the release version.');
  return { version: match[1], numbers: match[1].split('.').map(Number) };
}

export async function checkForUpdate(currentVersion, platform, arch, fetchRelease = fetch) {
  const response = await fetchRelease(latestRelease, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'DreamaticArt' },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`GitHub release check failed (HTTP ${response.status}).`);
  const release = await response.json();
  const current = versionParts(currentVersion);
  const latest = versionParts(release.tag_name);
  const difference = latest.numbers.map((value, index) => value - current.numbers[index]).find(value => value !== 0);
  if (!difference || difference < 0) return { version: latest.version, status: 'current' };

  const version = latest.version;
  const architectures = ['x64', 'arm64'];
  const names = !architectures.includes(arch) ? [] : platform === 'darwin'
    ? [`DreamaticArt-${version}-mac-${arch}.dmg`]
    : platform === 'win32' ? [
      `DreamaticArt-${version}-windows-${arch}-setup.exe`,
      `DreamaticArt-windows-${arch}-v${version}.zip`,
      `DreamaticArt-${version}-windows-${arch}-build.zip`,
    ] : [];
  const assets = Array.isArray(release.assets) ? release.assets : [];
  const asset = names.map(name => assets.find(item => item?.name === name)).find(Boolean);
  if (!asset) return { version, status: 'unavailable' };
  const url = `${repository}/releases/download/${encodeURIComponent(release.tag_name)}/${asset.name}`;
  if (asset.browser_download_url !== url || !Number.isSafeInteger(asset.size) || asset.size <= 0) {
    throw new Error('GitHub returned invalid installer metadata.');
  }
  return { version, status: 'available', asset: { name: asset.name, size: asset.size, digest: asset.digest, url } };
}

export async function downloadUpdate(asset, downloads, progress, fetchAsset = fetch) {
  const temporary = await mkdtemp(join(downloads, '.dreamatic-update-'));
  try {
    const response = await fetchAsset(asset.url, { signal: AbortSignal.timeout(30 * 60 * 1000) });
    if (!response.ok || !response.body) throw new Error(`Installer download failed (HTTP ${response.status}).`);

    const hash = createHash('sha256');
    let received = 0;
    const monitor = new Transform({
      transform(chunk, _encoding, callback) {
        received += chunk.length;
        if (received > asset.size) {
          callback(new Error('Installer size differs from the release metadata.'));
          return;
        }
        hash.update(chunk);
        progress(received / asset.size);
        callback(null, chunk);
      },
    });
    const staging = join(temporary, asset.name);
    await pipeline(Readable.fromWeb(response.body), monitor, createWriteStream(staging, { flags: 'wx' }));
    if (received !== asset.size) throw new Error('Installer size differs from the release metadata.');
    if (asset.digest && `sha256:${hash.digest('hex')}` !== asset.digest) {
      throw new Error('Installer checksum differs from the release metadata.');
    }

    const extension = extname(asset.name);
    const stem = asset.name.slice(0, -extension.length);
    for (let index = 0; ; index++) {
      const path = join(downloads, index ? `${stem} (${index})${extension}` : asset.name);
      try {
        await copyFile(staging, path, constants.COPYFILE_EXCL);
        return path;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
