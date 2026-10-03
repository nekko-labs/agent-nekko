/**
 * Web build (development previews only): there's no llama.cpp in a browser
 * tab here, so the engine reports itself unavailable and the Models screen
 * says so instead of offering downloads that can't run.
 */
import type { ChatTurn, Engine } from './llama';

export type { ChatTurn, Engine };

export const engineSupported = false;

export async function loadEngine(): Promise<Engine> {
  throw new Error('On-device models run in the iOS and Android apps.');
}
