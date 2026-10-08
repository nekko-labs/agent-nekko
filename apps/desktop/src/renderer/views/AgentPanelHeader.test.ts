import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// WorkspacesView pulls in the whole Agent tab, so these check its source.
const source = readFileSync(new URL('./WorkspacesView.tsx', import.meta.url), 'utf8');
const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
const toolbar = readFileSync(new URL('./CommandCenterView.tsx', import.meta.url), 'utf8');

describe('Agents panel header', () => {
  it('hides with a left-panel icon rather than an X, and swaps sides with the curved-arrow icon', () => {
    expect(source).toContain('aria-label="Hide the agent panel"');
    expect(source).toMatch(/aria-label="Hide the agent panel"[\s\S]{0,80}<PanelLeftIcon/);
    expect(source).toContain('<PanelSwapIcon');
    expect(source).not.toContain('Close the agent panel');
    expect(source).not.toContain('<CloseIcon');
    expect(toolbar).toMatch(/aria-label="Show the agent panel"[^\n]*<PanelLeftIcon/);
  });
  it('draws no outer ring around the Agents tab panel in either orientation', () => {
    expect(source).toContain("className={`panel ${sidebarOnly ? '' : 'panel-ring '}flex");
  });
  it('renders the + in the accent, a size up, with its menu portalled above the wall', () => {
    expect(source).toContain('agent-panel-plus');
    expect(source).toContain('<PlusIcon className="h-[22px] w-[22px]" />');
    expect(css).toContain('.agent-panel-plus { color: var(--accent); }');
    expect(source).toMatch(/newMenuOpen && newMenuPos && createPortal\(/);
    expect(source).toContain('className="card fixed z-[1000] w-64 p-1.5 shadow-lg"');
    expect(source).toContain('document.body,');
  });
  it('centres Add window on the wall edge, between the wall and the composer, with no elbow arrow', () => {
    expect(toolbar).toContain("wall.composer.side === 'bottom' && <>{addButton}{composerRow}</>");
    expect(toolbar).toContain("wall.composer.side === 'top' && <>{composerRow}{addButton}</>");
    expect(toolbar).not.toContain('wall-add-arrow');
    expect(css).not.toContain('.wall-add-arrow');
    expect(css).toContain(".wall-add-launch { position: relative; display: flex; justify-content: center;");
  });
});
