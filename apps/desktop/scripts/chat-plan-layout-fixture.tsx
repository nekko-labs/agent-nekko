import './wall-polish-chrome';
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { QuestionCard } from '../src/renderer/components/QuestionCard';
import { WorkingSubagents } from '../src/renderer/components/WorkingSubagents';
import { removePane, type WbNode } from '../src/renderer/layout';
import '../src/renderer/styles.css';
const leaf = (id: string): WbNode => ({ id, kind: 'chat', refId: id });
const initial: WbNode = { id: 'grid', dir: 'col', sizes: [.5,.5], children: [
 { id: 'row-top', dir: 'row', sizes: [.5,.5], children: [leaf('left-top'),leaf('top')] },
 { id: 'row-bottom', dir: 'row', sizes: [.5,.5], children: [leaf('left-bottom'),leaf('middle')] },
] };
const events: any[] = [];
function Tree({ node }: { node: WbNode }) {
  if ('children' in node) return <div style={{display:'flex',flexDirection:node.dir === 'col' ? 'column':'row',height:'100%',gap:4}}>{node.children.map((child,i)=><div key={child.id} style={{flex:node.sizes[i],minHeight:0,minWidth:0}}><Tree node={child}/></div>)}</div>;
  return <div data-pane={node.id} className="bg-surface rounded-lg" style={{height:'100%',padding:12}}>{node.id}</div>;
}
function Fixture() {
 const [tree,setTree]=useState(initial);
 const [epoch,setEpoch]=useState(0);
  const [running,setRunning]=useState(new Set(['child1','child2']));
 Object.assign(window,{integration:{setRunning:(ids: string[])=>setRunning(new Set(ids)),reset:()=>{setRunning(new Set(['child1','child2']));events.length=0;setTree(initial);setEpoch(e=>e+1)},remove:()=>setTree(t=>removePane(t,'middle')!),events}});
 return <main key={epoch} className="bg-paper text-ink" style={{height:'100vh',padding:20,display:'flex',flexDirection:'column',gap:16}}>
 <section data-question><QuestionCard tone="attention" request={{callId:'fixture',askedAt:1,questions:[{id:'branch',header:'Branch',question:'Which branch should I use?',options:[{label:'Feature branch',description:'Keep the changes isolated.'},{label:'Existing branch',description:'Continue the current work.'}]}]}} onAnswer={a=>events.push({answer:a})} onSkip={()=>events.push({skip:true})}/></section>
 <section data-agent-window className="bg-surface rounded-lg" style={{position:'relative',height:150,flexShrink:0,padding:16}}><span>Synthetic agent window</span><WorkingSubagents children={[{id:'child1',title:'Inspect layout'},{id:'child2',title:'Verify question styles'}] as any} running={running} pending={{}} onOpen={id=>events.push({open:id})}/></section>
 <button data-remove onClick={()=>setTree(t=>removePane(t,'middle')!)}>Close middle pane</button>
 <section data-tree style={{flex:1,minHeight:120}}><Tree node={tree}/></section>
 </main>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
