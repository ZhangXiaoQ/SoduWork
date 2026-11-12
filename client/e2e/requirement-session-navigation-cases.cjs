'use strict';

// Shared with the production Compose/NativeChat harness. Service responses are
// deterministic; sidebar rows, navigation, transcript and clocks are real UI.
const assert = require('node:assert/strict');
const { project } = require('../main/pi-session/controlled-execution-snapshot.cjs');

module.exports = async function navigationCases({ runCase, js, click, until, phase, reloadPage, recordNavigation }) {
  const runtimes = require('../main/agent-runtime/runtime-catalog').runtimes();
  async function sidebar(ids) {
    await js(`(() => {
      document.getElementById('navigation-fixture')?.remove();
      const container = document.createElement('aside'); container.id = 'navigation-fixture';
      container.style.cssText = 'position:fixed;left:0;top:0;width:200px;z-index:99999;background:var(--bg,#fff)';
      const list = WorkspaceChatList.create({icon:()=>'',setActiveChat:()=>{}});
      window.WorkspaceHost = {open:(_surface,options)=>{window.lastSidebarNavigation=openComposePanel(options);}};
      for (const id of ${JSON.stringify(ids)}) {
        const row = list._newChatRow();
        const button = row.querySelector('.ws-chat'); button.dataset.chatId=id;
        button.querySelector('.ws-chat-title').textContent=id;
        container.append(row);
      }
      document.body.append(container);
    })()`);
  }
  const select = async id => {
    const started = performance.now();
    await click('.ws-chat[data-chat-id="' + id + '"]');
    await until(`NativeChat.sessionInfo().sessionId===${JSON.stringify(id)} && Boolean(NativeChat.sessionInfo().ref)`);
    await js('new Promise(resolve=>requestAnimationFrame(()=>resolve(true)))');
    recordNavigation({sessionId:id, elapsedMs:performance.now()-started});
  };
  for (const runtime of runtimes) {
    await runCase('sidebar switching preserves active requirement for ' + runtime.id, async () => {
      await reloadPage();
      const start = Date.now() - 13000;
      const id = 'running-' + runtime.id;
      const snapshot = { ...project({taskId:'fixture-task',status:'running',timing:{startedAt:start,updatedAt:start}}, 'fixture-turn'),
        adapterId:runtime.id, tools:[], messages:[
          {role:'user',text:'导航回归：编写春天散文',sentAt:start,taskOutputKey:'fixture-user'},
          {role:'assistant',done:false,sourceAgent:{agentId:runtime.id,runId:'fixture-turn'},
            blocks:[{kind:'text',text:'已读取材料，正在撰写正文。',done:false}],taskOutputKey:'fixture-answer'}] };
      await js(`runtimeRows=${JSON.stringify(runtimes)};
        fixtureSessions[${JSON.stringify(id)}]={ok:true,ref:${JSON.stringify('ref-' + id)},sessionId:${JSON.stringify(id)},
          adapterId:${JSON.stringify(runtime.id)},displayName:${JSON.stringify(runtime.displayName)},
          model:{id:'fixture-history',label:'历史会话模型'},snapshot:${JSON.stringify(snapshot)}};
        fixtureSessions['other-conversation']={ok:true,ref:'other-ref',sessionId:'other-conversation',adapterId:'pi',
          model:{id:'fixture-default',label:'默认模型'},snapshot:{status:'idle',messages:[{role:'user',text:'另一条会话',sentAt:1}],tools:[]}};
        void 0;`);
      await sidebar([id, 'other-conversation']);
      await select(id);
      const elapsed = () => js("document.querySelector('[data-thinking-elapsed]')?.textContent || ''");
      const before = await elapsed();
      assert.match(before, /1[3-9]s/);
      for (let index = 0; index < 5; index++) {
        await select('other-conversation');
        assert.doesNotMatch(await js("document.querySelector('#nchatList').innerText"), /已读取材料/);
        if (index === 0) {
          await js(`(() => {
            const saved=fixtureSessions[${JSON.stringify(id)}];
            saved.snapshot.messages[1].blocks[0].text+='后台执行仍在继续。';
            fixtureListeners.forEach(fn=>fn({ref:saved.ref,kind:'snapshot',snapshot:structuredClone(saved.snapshot)}));
          })()`);
          assert.doesNotMatch(await js("document.querySelector('#nchatList').innerText"), /后台执行仍在继续/);
        }
        await select(id);
        assert.match(await js("document.querySelector('#nchatList').innerText"), /已读取材料，正在撰写正文/);
        assert.match(await js("document.querySelector('#nchatList').innerText"), /后台执行仍在继续/);
        assert.equal(await js("document.querySelector('#nchatRuntimeName').textContent"), runtime.displayName);
        assert.equal(await js("document.querySelector('#nchatList [data-agent-brand]')?.dataset.agentBrand"), runtime.id);
      }
      assert.ok(parseInt(await elapsed(),10) >= parseInt(before,10), 'switching never resets elapsed work');
      await js(`fixtureSessions[${JSON.stringify(id)}].snapshot={...fixtureSessions[${JSON.stringify(id)}].snapshot,
        ...${JSON.stringify(project({taskId:'fixture-task',status:'done',timing:{startedAt:start,updatedAt:start+47000}}, 'fixture-turn'))}};
        const answer=fixtureSessions[${JSON.stringify(id)}].snapshot.messages[1];answer.done=true;
        answer.blocks=[{kind:'text',text:'最终交付：春天的散文已经完成。',done:true}];void 0;`);
      await select('other-conversation'); await select(id);
      assert.match(await js("document.querySelector('#nchatList').innerText"), /最终交付：春天的散文已经完成/);
      assert.doesNotMatch(await js("document.querySelector('#nchatList').innerText"), /正在打开会话|正在理解/);
      assert.equal(await elapsed(), '47s');
      assert.equal(await js('calls.sends.length'), 0, 'navigation never dispatches a turn');
      await phase('sidebar-completed-' + runtime.id);
      const retained = await js('structuredClone(fixtureSessions)');
      await reloadPage();
      await js(`runtimeRows=${JSON.stringify(runtimes)};fixtureSessions=${JSON.stringify(retained)};void 0;`);
      await sidebar([id]); await select(id);
      assert.match(await js("document.querySelector('#nchatList').innerText"), /最终交付：春天的散文已经完成/);
      assert.equal(await js("document.querySelector('#nchatRuntimeName').textContent"), runtime.displayName);
      assert.equal(await js("document.querySelector('#nchatList [data-agent-brand]')?.dataset.agentBrand"), runtime.id);
      assert.equal(await js('calls.sends.length'), 0, 'cold renderer restore does not execute the requirement again');
    });
    await runCase('paged historical requirement survives sidebar switching for ' + runtime.id, async () => {
      const id = 'legacy-' + runtime.id, taskId = 'task-' + runtime.id, ref = 'run-' + runtime.id;
      const chunks = ['完整历史开头。\n\n', '春', '春', ' ', '再次相逢。\n\n',
        '| 标准 | 结果 |\n| --- | --- |\n| 连续正文 | 完整 |\n\n',
        '```text\n' + 'long-command '.repeat(100) + '\n```\n\n完整历史结尾。'];
      const events = Array.from({ length: 410 }, (_, index) => ({ seq: index + 1,
        kind: 'thinking', streamId: 'reasoning', delta: true, text: '检查' })).concat(
        chunks.map((text, index) => ({ seq: 411 + index, kind: 'say', streamId: 'answer',
          sourceId: 'provider-message', delta: true, text })),
        [{ seq: 418, kind: 'say', streamId: 'answer', delta: true, text: '', done: true }]);
      const install = async () => {
        await js(`runtimeRows=${JSON.stringify(runtimes)};
          tasks=[{id:${JSON.stringify(taskId)},title:'历史正文恢复',status:'done',
            workRouting:{conversationTurn:{conversationId:${JSON.stringify(id)},executor:'dispatch',state:'completed'}}}];
          fixtureSessions[${JSON.stringify(id)}]={ok:true,ref:${JSON.stringify('native-' + id)},sessionId:${JSON.stringify(id)},
            adapterId:${JSON.stringify(runtime.id)},displayName:${JSON.stringify(runtime.displayName)},
            taskBindings:[{taskId:${JSON.stringify(taskId)},title:'历史正文恢复'}],
            model:{id:'fixture-history',label:'历史模型'},snapshot:{status:'idle',tools:[],
              messages:[{role:'user',text:'恢复历史正文',taskId:${JSON.stringify(taskId)}}]}};
          fixtureSessions['other-conversation']={ok:true,ref:'other-ref',sessionId:'other-conversation',adapterId:'pi',
            snapshot:{status:'idle',messages:[{role:'user',text:'另一条会话'}],tools:[]}};
          window.transcriptReads=[];
          SoduWorkAPI.taskTrace=async()=>({execution:{sessions:[{ref:${JSON.stringify(ref)},seq:418,status:'done',
            items:[{seq:418,kind:'say',text:'This bounded tail must never replace the full history'}]}]}});
          SoduWorkAPI.aiSession=async(task,since,requestedRef)=>{
            transcriptReads.push({task,since,ref:requestedRef});
            const items=${JSON.stringify(events)}.filter(item=>item.seq>since).slice(0,200);
            return {ok:true,ref:${JSON.stringify(ref)},conversationId:${JSON.stringify(id)},status:'done',
              seq:418,last:items.at(-1)?.seq||since,items};
          };void 0;`);
        await sidebar([id, 'other-conversation']);
      };
      const verify = async () => {
        await until("document.querySelector('[data-task-stream]')?.innerText.includes('完整历史结尾。')");
        await js("document.querySelector('#nchatList').style.width='360px';void 0;");
        const body = await js("document.querySelector('[data-task-stream]').innerText");
        assert.match(body, /完整历史开头。/); assert.match(body, /春春 再次相逢。/);
        assert.doesNotMatch(body, /bounded tail/);
        assert.equal(await js("document.querySelectorAll('[data-task-stream] .dks-message').length"), 1);
        assert.equal(await js("document.querySelectorAll('[data-task-stream] .nmd table').length"), 1);
        assert.equal(await js("getComputedStyle(document.querySelector('[data-task-stream] table')).overflowX"), 'auto');
        const bounds = await js("(() => { const stream=document.querySelector('[data-task-stream]');return {width:stream.clientWidth,scroll:stream.scrollWidth,children:[...stream.querySelectorAll('article, .nmd, pre')].map(node=>({tag:node.tagName,width:node.clientWidth,scroll:node.scrollWidth,display:getComputedStyle(node).display}))};})()");
        assert.ok(bounds.width > 0 && bounds.scroll <= bounds.width + 1,
          'narrow panes retain wrapping without clipping the transcript: ' + JSON.stringify(bounds));
        assert.equal(await js("document.querySelector('#nchatRuntimeName').textContent"), runtime.displayName);
        assert.equal(await js('calls.sends.length'), 0);
        assert.ok((await js('transcriptReads')).every(row => row.task === taskId && row.ref === ref));
      };
      await reloadPage(); await install(); await select(id); await verify();
      await select('other-conversation');
      assert.doesNotMatch(await js("document.querySelector('#nchatList').innerText"), /完整历史开头/);
      await select(id); await verify();
      await reloadPage(); await install(); await select(id); await verify();
      await phase('sidebar-historical-' + runtime.id);
    });
  }
  await runCase('sidebar switching escapes an unresponsive work archive and fences its late reply', async () => {
    await reloadPage(); await sidebar(['stalled-archive', 'history-session']);
    await js('delayWorkCards=true;void 0;');
    await click('.ws-chat[data-chat-id="stalled-archive"]');
    await until('Boolean(pendingWorkCards)');
    await select('history-session');
    await js('pendingWorkCards();void 0;');
    await until("NativeChat.sessionInfo().ref==='history-ref'");
    assert.equal(await js('NativeChat.sessionInfo().sessionId'), 'history-session');
    assert.equal(await js('calls.sends.length'), 0);
    await phase('sidebar-stalled-archive-escaped');
  });
  await runCase('unresponsive work archive settles within the production opening deadline', async () => {
    await reloadPage(); await sidebar(['stalled-archive', 'history-session']);
    await js('delayWorkCards=true;void 0;');
    await click('.ws-chat[data-chat-id="stalled-archive"]');
    await until('Boolean(pendingWorkCards)');
    const start = Date.now();
    await js('lastSidebarNavigation.then(()=>true)');
    assert.ok(Date.now()-start < 35000, 'card recovery has a bounded completion');
    assert.match(await js('document.body.innerText'), /工作卡片暂时无法读取/);
    assert.equal(await js('calls.opens.length'), 0, 'a missing card archive cannot open a substitute runtime');
    await select('history-session');
    await js('pendingWorkCards();void 0;');
    assert.equal(await js('NativeChat.sessionInfo().sessionId'), 'history-session');
    await phase('sidebar-timeout-recovered');
  });
};
