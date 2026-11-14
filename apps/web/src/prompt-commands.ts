import type { SolutionTaskInput } from './api';

export const commands = {
  append: 'append', '追加': 'append',
  recompose: 'recompose', '重排': 'recompose',
  fuse: 'fuse', '融合': 'fuse',
  split: 'split', '拆分': 'split',
  replace: 'replace', '替换': 'replace',
  edit: 'edit', '修改': 'edit',
} as const;

export function operationCommand(operation: SolutionTaskInput['operation'], chinese = false) {
  if (operation === 'revise') return chinese ? '/修改' : '/edit';
  const labels = { append: '追加', recompose: '重排', fuse: '融合', split: '拆分', replace: '替换' };
  return `/${chinese ? labels[operation] : operation}`;
}

export function promptCommand(text: string): {
  prompt: string; operation?: SolutionTaskInput['operation']; count?: number; error?: string; solutionOnly?: boolean;
} {
  const value = text.trim();
  if (!value.startsWith('/')) return { prompt: value };
  const [, name = '', body = ''] = /^\/([^\s]*)(?:\s+([\s\S]*))?$/u.exec(value) ?? [];
  if (!Object.hasOwn(commands, name.toLowerCase())) return { prompt: '', error: 'Unknown prompt command. Open Commands to see the available options.' };
  const operation = commands[name.toLowerCase() as keyof typeof commands];
  if (operation === 'edit') return { prompt: body, operation: 'revise' };
  if (operation === 'split') {
    const count = /^(\d+)(?:\s+|$)/u.exec(body);
    if (count && ![2, 3, 4].includes(Number(count[1]))) return { prompt: '', error: 'Split supports two to four outputs.', solutionOnly: true };
    return { operation, solutionOnly: true, ...(count ? { count: Number(count[1]) } : {}),
      prompt: (count ? body.slice(count[0].length).trim() : body) || 'Split the connected solution into distinct, complete directions.' };
  }
  if (operation === 'append') return { prompt: body, operation, solutionOnly: true };
  const defaults = { fuse: 'Combine the connected solutions into one cohesive design.', recompose: 'Recompose the showcase while preserving the design and all images.' };
  return { operation, solutionOnly: true, prompt: body || (operation === 'replace' ? '' : defaults[operation]) };
}
