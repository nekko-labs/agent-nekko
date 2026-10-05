import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { readFile } from './files.js';
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture(name: string, data: Buffer | string) {
  const dir = mkdtempSync(join(tmpdir(), 'nekko-image-')); dirs.push(dir);
  const path = join(dir, name); writeFileSync(path, data); return path;
}
describe('explicit file image previews', () => {
  it('returns a bounded raster data URL with verified PNG signature', () => {
    const data = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=', 'base64');
    expect(readFile(fixture('shot.png', data)).imageDataUrl).toBe(`data:image/png;base64,${data.toString('base64')}`);
  });
  it('does not trust extensions or inline SVG as raster data', () => {
    expect(readFile(fixture('fake.png', '<script>alert(1)</script>')).imageDataUrl).toBeUndefined();
    expect(readFile(fixture('image.svg', '<svg/>')).imageDataUrl).toBeUndefined();
  });
  it('rejects oversized images before encoding', () => {
    const result = readFile(fixture('large.png', Buffer.alloc(8_000_001)));
    expect(result.truncated).toBe(true); expect(result.imageDataUrl).toBeUndefined();
  });
});
