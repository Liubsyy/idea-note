// Real history UI, mocked Git/filesystem: no user files are read or written.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { mockIPC, mockWindows } from '@tauri-apps/api/mocks';
import '../src/styles/globals.css';

const host = document.getElementById('test-history')!;
const result = document.getElementById('test-result')!;
const calls: {command: string; args: any}[] = [];
const workspace = 'D:/Dev/Project';
let slowLog = false;
const delay = (ms:number) => new Promise(resolve => setTimeout(resolve,ms));
mockWindows('main');
mockIPC(async (command, args) => {
  if (['git_run','read_file','write_file'].includes(command)) calls.push({command,args});
  if (command === 'sync_config_load') return '{}';
  if (command === 'git_proxy_load') return '';
  if (command === 'read_file') return String(args?.path).endsWith('inside.md') ? 'PROJECT current' : 'EXTERNAL personal note';
  if (command === 'write_file') throw new Error('unexpected write');
  if (command === 'git_run') {
    const gitArgs = args?.args as string[];
    let stdout = '';
    if (gitArgs.includes('log')) {
      if (slowLog) await delay(350);
      stdout = '\x01abc123\tabc123\tTest Author\t1700000000\tProject commit\ninside.md\n';
    } else if (gitArgs.includes('status')) stdout = ' M inside.md\n';
    else if (gitArgs.includes('show')) stdout = 'HEAD project content';
    else if (gitArgs.includes('--show-toplevel')) stdout = workspace + '\n';
    return {code:0,stdout,stderr:''};
  }
  return null;
}, {shouldMockEvents:true});
function check(value:unknown, label:string): asserts value { if (!value) throw new Error(label); }
async function until(test:()=>unknown, label:string) {
  for (let n=0;n<120;n++) { if(test()) return; await delay(25); }
  throw new Error(`Timed out: ${label}`);
}
function click(text:string) {
  const button = [...host.querySelectorAll('button')].find(b=>b.textContent===text);
  check(button,`missing ${text}`); button.click();
}
const passed:string[] = [];
try {
  const {useAppStore} = await import('../src/store/useAppStore');
  const {HistoryModal} = await import('../src/components/HistoryModal');
  const root=createRoot(host);
  useAppStore.setState({workspacePath:workspace,activeFilePath:'C:/note.md',content:'EXTERNAL personal note',isDirty:false});
  useAppStore.getState().openHistory();
  root.render(<HistoryModal/>);
  await until(()=>host.textContent?.includes('当前文件不属于此项目'),'external file note');
  check(calls.length===0 && !host.querySelector('.cm-history-diff'),'external file triggers no Git/file reads or diff');
  check(!host.textContent?.includes('撤销未提交更改') && !host.textContent?.includes('回退到此版本'),'external file has no destructive action');
  await useAppStore.getState().rollbackToVersion({hash:'abc123',shortHash:'abc123',author:'test',timestamp:0,subject:'test',path:'inside.md'},'wrong content');
  check(calls.length===0,'direct external rollback blocked before any I/O');
  passed.push('external file has no project diff or rollback');

  click('全局历史');
  await until(()=>host.textContent?.includes('PROJECT current'),'global history');
  check(host.textContent?.includes('HEAD project content') && !host.textContent?.includes('EXTERNAL personal note'),'global history compares project files only');
  click('当前文件');
  await until(()=>host.textContent?.includes('当前文件不属于此项目'),'return external file');
  check(!host.querySelector('.cm-history-diff'),'no stale global diff');
  passed.push('global history remains available and correctly scoped');

  for (const outside of [`${workspace}-other/inside.md`,`${workspace}/../other.md`,'draft:untitled']) {
    calls.length=0;
    useAppStore.getState().openHistoryAt(outside,'file');
    await until(()=>host.textContent?.includes('当前文件不属于此项目'),'outside boundary');
    await delay(30);
    check(calls.length===0,'prefix collision/traversal/draft never queried');
  }
  passed.push('prefix collisions, traversal and draft paths');

  useAppStore.setState({activeFilePath:`${workspace}/inside.md`,content:'PROJECT current'});
  useAppStore.getState().openHistoryAt(`${workspace}/inside.md`,'file');
  await until(()=>host.textContent?.includes('PROJECT current'),'inside diff');
  check(host.textContent?.includes('HEAD project content') && host.textContent?.includes('撤销未提交更改'),'valid file history and actions');
  check(calls.some(c=>c.command==='git_run' && c.args.args.includes('./inside.md')),'file-specific Git path');
  passed.push('project file history still works');

  slowLog=true;
  useAppStore.getState().closeHistory(); await delay(30);
  useAppStore.getState().openHistory();
  await until(()=>host.textContent?.includes('加载历史'),'pending history');
  useAppStore.setState({workspacePath:'D:/OtherProject'});
  await until(()=>host.textContent?.includes('当前文件不属于此项目'),'workspace switched');
  await delay(450);
  check(!host.querySelector('.cm-history-diff') && !host.textContent?.includes('Project commit'),'late results from old workspace discarded');
  useAppStore.getState().openHistoryAt(workspace,'dir');
  await until(()=>host.textContent?.includes('此文件夹不属于当前项目'),'external directory blocked');
  useAppStore.setState({workspacePath:null});
  await until(()=>host.textContent?.includes('还没有打开工作区'),'no workspace empty state');
  passed.push('workspace changes cancel stale history and external directories stay blocked');
  root.unmount();
  result.textContent=`PASS (${passed.length} groups): ${passed.join('; ')}`;
  document.title='PASS — history boundary regression';
} catch(error) {
  result.textContent=`FAIL after ${passed.join('; ')}: ${String(error)}`;
  document.title='FAIL — history boundary regression';
  console.error(error);
}
