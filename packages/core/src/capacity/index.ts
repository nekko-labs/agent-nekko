/**
 * Capacity planning: the pure math behind "will this model fit, where will it
 * run, and why". No I/O, no clock, no runtime knowledge. The host gathers the
 * facts; this decides what they mean.
 */

export * from './kv.js';
export * from './plan.js';
export * from './suggest.js';
export * from './autofit.js';
