import { describe, expect, it } from 'vitest';
import { parseSkillMarkdown } from './skill-markdown.js';

describe('parseSkillMarkdown', () => {
  it('reads plain, quoted and folded frontmatter values', () => {
    const parsed = parseSkillMarkdown(
      '---\nname: "pdf"\ndescription: >\n  Work with PDFs.\n  Use for forms.\nlicense: MIT\nmetadata:\n  name: nested\n---\n# PDF\nBody',
    );
    expect(parsed.name).toBe('pdf');
    expect(parsed.description).toBe('Work with PDFs. Use for forms.');
    expect(parsed.body).toBe('# PDF\nBody');
  });

  it('treats a file without frontmatter as body only', () => {
    expect(parseSkillMarkdown('Just instructions')).toEqual({ body: 'Just instructions' });
  });

  it('handles a BOM and CRLF line endings', () => {
    const parsed = parseSkillMarkdown('\uFEFF---\r\nname: crlf\r\n---\r\nBody line');
    expect(parsed.name).toBe('crlf');
    expect(parsed.body).toBe('Body line');
  });
});
