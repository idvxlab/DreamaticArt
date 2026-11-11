export function dimensions(size: string): [number, number] {
  const match = /^(\d+)x(\d+)$/.exec(size.trim());
  if (!match || !Number.isSafeInteger(Number(match[1])) || !Number.isSafeInteger(Number(match[2])) || Number(match[1]) < 1 || Number(match[2]) < 1) throw new Error(`Invalid image size: ${size}`);
  return [Number(match[1]), Number(match[2])];
}
export interface PlannedImage { id: string; introduction: string; size: string; prompt: string }
export function plannedImages(markdown: string): PlannedImage[] {
  const images = [...markdown.matchAll(/^## Image: ([a-zA-Z0-9_-]+)\s*\n([\s\S]*?)(?=^## |$(?![\s\S]))/gm)].map(m => {
    const field = (name: string) => new RegExp(`^### ${name}\\s*\\n([\\s\\S]*?)(?=^#{1,3} |$(?![\\s\\S]))`, 'm').exec(m[2]!)?.[1]?.trim() || '';
    const size = field('Size'); dimensions(size);
    const prompt = field('Prompt'); if (!prompt) throw new Error(`Missing prompt: ${m[1]}`);
    return { id: m[1]!, introduction: field('Introduction'), size, prompt };
  });
  if (!images.length || new Set(images.map(i => i.id)).size !== images.length) throw new Error('Design must contain distinct valid Image sections');
  return images;
}
