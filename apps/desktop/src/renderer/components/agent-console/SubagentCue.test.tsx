import React from 'react';
import { expect, it, vi } from 'vitest';
vi.mock('../Markdown.js', () => ({ Markdown: ({ text }: { text: string }) => <p>{text}</p> }));
import { renderToStaticMarkup } from 'react-dom/server';
import { ActivityGroup } from './ActivityGroup.js';
import { ToolCard } from './ToolCard.js';
import { toStreamBlocks } from './transcript.js';
import { MessageBubble } from './MessageBubble.js';
import type { ChatMessage, ToolCall } from '@agent-nekko/shared';

const call: ToolCall = { id: 'child', name: 'spawn_agent', input: { title: 'Integration checks', task: 'Run tests' } };
it('keeps delegation identifiable in collapsed groups and tool cards', () => {
  const html = renderToStaticMarkup(<ActivityGroup items={[{ kind: 'tool', call }]} />);
  expect(html).toContain('1 subagent');
  expect(html).toContain('Integration checks');
  expect(html.match(/<svg/g)).toHaveLength(2);
  expect(renderToStaticMarkup(<ToolCard call={call} />)).toContain('To subagent · Integration checks');
  expect(renderToStaticMarkup(<ActivityGroup items={[{kind:'tool',call:{...call,name:'read_file'}}]} />)).not.toContain('subagent');
});
it('attaches only the matching delegation result, including errors, to the persisted step', () => {
  const messages: ChatMessage[] = [
    {id:'a',role:'assistant',content:'',createdAt:0,toolCalls:[call]},
    {id:'other',role:'tool',content:'unrelated',createdAt:0,toolResult:{toolCallId:'other',output:'unrelated'}},
    {id:'result',role:'tool',content:'Test failed',createdAt:0,toolResult:{toolCallId:call.id,output:'Test failed',isError:true}},
  ];
  const blocks = toStreamBlocks(messages);
  expect(blocks).toHaveLength(1);
  expect(blocks[0]).toMatchObject({type:'activity',items:[{kind:'tool',call,result:{output:'Test failed',isError:true}}]});
});
it('labels legacy watch wake-ups without treating assistant quotations as automated messages', () => {
  const message: ChatMessage = {id:'watch',role:'user',content:'[Agent watch abc]\nCheck CI',createdAt:0};
  expect(renderToStaticMarkup(<MessageBubble message={message} />)).toContain('Agent watch · automated wake-up');
  expect(renderToStaticMarkup(<MessageBubble message={{...message,role:'assistant'}} />)).not.toContain('automated wake-up');
});
