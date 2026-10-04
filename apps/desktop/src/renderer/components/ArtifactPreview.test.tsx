import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ArtifactPreview, isolatedDocument, MermaidDiagram } from './ArtifactPreview.js';
import { Markdown } from './Markdown.js';

describe('artifact previews', () => {
  it('puts network and app isolation policy before untrusted content', () => {
    const html = isolatedDocument('<script>fetch("https://example.com")</script>');
    expect(html.indexOf('Content-Security-Policy')).toBeLessThan(html.indexOf('<script>'));
    for (const policy of ["default-src 'none'", "connect-src 'none'", "form-action 'none'", "base-uri 'none'"]) expect(html).toContain(policy);
    expect(html).not.toContain('allow-same-origin');
  });
  it('starts with scripts disabled and exposes responsive viewport controls', () => {
    const html = renderToStaticMarkup(<ArtifactPreview source="<h1>Design</h1>" />);
    expect(html).toContain('sandbox=""');
    expect(html).toContain('Enable interactions');
    expect(html).toContain('375px');
    expect(html).toContain('1280px');
  });
  it('keeps diagram source available before async rendering', () => {
    expect(renderToStaticMarkup(<MermaidDiagram code="graph TD; A-->B" />)).toContain('Mermaid source');
    expect(renderToStaticMarkup(<Markdown text={'```mermaid\ngraph TD; A-->B\n```'} />)).toContain('Rendering diagram');
  });
  it('does not read or fetch an image during message rendering', () => {
    const html = renderToStaticMarkup(<Markdown text="![Evidence](/project/shot.png)" />);
    expect(html).toContain('Load image');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('src=');
  });
  it('opens local artifacts but rejects executable and network-share targets', () => {
    expect(renderToStaticMarkup(<Markdown text="[Report](/project/report.md)" />)).toContain('Open /project/report.md');
    for (const path of ['javascript:alert', 'data:text/html,hello', '//server/share']) {
      expect(renderToStaticMarkup(<Markdown text={`[bad](${path})`} basePath="/project" />)).not.toContain('<button');
    }
  });
});
