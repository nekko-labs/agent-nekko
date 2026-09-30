import { describe, expect, it } from 'vitest';
import { moveNav, navOrder } from './nav-order.js';
describe('navigation ordering', () => {
  it('drops unknown ids, removes duplicates and retains newly added views', () => {
    expect(navOrder(['chat','models','settings'], ['settings','bad','settings'])).toEqual(['settings','chat','models']);
  });
  it('preserves hidden destinations while moving visible ones', () => {
    expect(moveNav(['chat','training','models','settings'], 'settings','chat')).toEqual(['settings','chat','training','models']);
  });
  it('does not mutate input or reorder unknown destinations', () => {
    const order = ['chat','models']; expect(moveNav(order,'missing','models')).toEqual(order); expect(order).toEqual(['chat','models']);
  });
});
