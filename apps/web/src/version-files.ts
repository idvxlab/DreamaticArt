import { solutionFileUrl, type SolutionVersion } from './api';
import type { ProjectFile } from './types';

export function versionFiles(version: SolutionVersion, category: 'assets' | 'context'): ProjectFile[] {
  const entries = category === 'assets'
    ? [...version.images.map(image => ({ path: image.path, title: image.id })), ...(version.videos ?? [])]
    : [{ path: version.designPath, title: 'Design document' }, ...(version.exhibitionPath ? [{ path: version.exhibitionPath, title: 'Exhibition direction' }] : [])];
  return entries.map(({ path, title }) => ({
    id: `version:${version.id}:${path}`, path, title, category,
    versionId: version.id, url: solutionFileUrl(version, path),
    kind: path.split('.').at(-1)!.toLowerCase(), group: version.title,
  }));
}
