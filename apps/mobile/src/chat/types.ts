import type { AskAnswer, AskRequest } from '@/lib/protocol';
import type { Approval, Block } from '@/lib/transcript';

/** What the chat screen needs, whichever side the chat runs on. */
export interface ChatModel {
  ready: boolean;
  title: string;
  /** "Gemma 4 12B · Windows PC" or "Qwen3.5 2B · on this phone". */
  subtitle: string;
  where: 'computer' | 'phone';
  blocks: Block[];
  running: boolean;
  approval?: Approval;
  question?: AskRequest;
  error?: string;
  /** Why sending is blocked right now (computer offline, no model). */
  blocked?: string;
  /** Prompts waiting to run after the current turn (computer chats). */
  queued?: string[];
  rate?: number;
  thinking?: { on: boolean; toggle(): void };
  send(text: string): Promise<void>;
  stop(): void;
  approve(ok: boolean): Promise<void>;
  answer(answers: AskAnswer[]): Promise<void>;
}
