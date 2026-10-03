import { describe, expect, it } from 'vitest';
import { parseBlocks, parseInline, plainText } from './markdown';

describe('parseBlocks', () => {
  it('splits a typical reply', () => {
    const md = '# Plan\n\nFirst **do** this:\n\n1. one\n2. two\n   wrapped\n- a\n\n```ts\nconst x = 1;\n```\n> note';
    expect(parseBlocks(md)).toEqual([
      { kind: 'heading', level: 1, text: 'Plan' },
      { kind: 'para', text: 'First **do** this:' },
      { kind: 'list', ordered: true, items: ['one', 'two wrapped'] },
      { kind: 'list', ordered: false, items: ['a'] },
      { kind: 'code', lang: 'ts', text: 'const x = 1;' },
      { kind: 'quote', text: 'note' },
    ]);
  });

  it('renders an unclosed fence while streaming', () => {
    expect(parseBlocks('Here:\n```py\nprint(1)')).toEqual([
      { kind: 'para', text: 'Here:' },
      { kind: 'code', lang: 'py', text: 'print(1)' },
    ]);
  });
});

describe('parseInline', () => {
  it('finds code, bold, italic and links', () => {
    expect(parseInline('Run `npm i` **now**, *please*, see [docs](https://x.dev).')).toEqual([
      { text: 'Run ' },
      { text: 'npm i', code: true },
      { text: ' ' },
      { text: 'now', bold: true },
      { text: ', ' },
      { text: 'please', italic: true },
      { text: ', see ' },
      { text: 'docs', href: 'https://x.dev' },
      { text: '.' },
    ]);
  });

  it('leaves lone asterisks alone', () => {
    expect(parseInline('2 * 3 = 6')).toEqual([{ text: '2 * 3 = 6' }]);
  });
});

describe('underscore italics', () => {
  it('reads _x_ as italic but leaves snake_case alone', () => {
    expect(parseInline('You said: _hello there_')).toEqual([{ text: 'You said: ' }, { text: 'hello there', italic: true }]);
    expect(parseInline('call read_file_now')).toEqual([{ text: 'call read_file_now' }]);
  });
});

describe('plainText', () => {
  it('flattens a reply for a one-line preview', () => {
    expect(plainText('The command finished. It printed:\n\n```\nHello\nv24\n```\n\n**Done**, see [docs](https://x.dev).')).toBe(
      'The command finished. It printed: Hello v24 Done, see docs.',
    );
    expect(plainText("Hi! I'm the model on your **computer**")).toBe("Hi! I'm the model on your computer");
    expect(plainText('# Title\n- _one_\n- read_file_now')).toBe('Title one read_file_now');
  });
});
