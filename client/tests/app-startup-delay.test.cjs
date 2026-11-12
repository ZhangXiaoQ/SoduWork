'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events');
const {attach}=require('../main/work-preview-app-tabs.cjs');
function fixture(t){
  t.mock.timers.enable({apis:['setTimeout']});
  const wc=Object.assign(new EventEmitter(),{navigationHistory:{canGoBack:()=>false},getURL:()=>'',getTitle:()=>'',isLoading:()=>true,
    isDestroyed:()=>false,capturePage:async()=>({}),reload(){},focus(){},setWindowOpenHandler(){},close(){}});
  const view={webContents:wc,setVisible(){}};
  const item={id:'app',view,detachedWin:{contentView:{removeChildView(){}},close(){}}};
  const controller=attach({owner:{},item,layout(){}});t.after(()=>controller.dispose());
  return {controller,wc};
}
test('loading and load failure keep retry hidden until exactly two minutes',t=>{
  const {controller,wc}=fixture(t);
  wc.emit('did-fail-load',{},-2,'failure','https://fixture.invalid',true);
  assert.equal(controller.state().canRetry,false);
  t.mock.timers.tick(119999);assert.equal(controller.state().canRetry,false);
  t.mock.timers.tick(1);assert.equal(controller.state().canRetry,true);
  controller.action('refresh');assert.equal(controller.state().canRetry,false);
  t.mock.timers.tick(119999);assert.equal(controller.state().canRetry,false);
  t.mock.timers.tick(1);assert.equal(controller.state().canRetry,true);
});
test('successful first frame and disposal cancel delayed retry',async t=>{
  const {controller,wc}=fixture(t);
  t.mock.timers.tick(119999);wc.emit('did-finish-load');await Promise.resolve();
  assert.equal(controller.state().startup,'ready');
  t.mock.timers.tick(120000);assert.equal(controller.state().canRetry,false);
  controller.action('refresh');controller.dispose();t.mock.timers.tick(120000);
  assert.equal(controller.state().canRetry,false);
});

test('opened pages remain usable during document navigation, cancellation and refresh',async t=>{
  const {controller,wc}=fixture(t);
  wc.emit('did-finish-load');await Promise.resolve();
  for(const start of [()=>wc.emit('did-start-navigation',{isMainFrame:true,isSameDocument:false}),
    ()=>wc.emit('did-start-navigation',{},'https://fixture.invalid/next',false,true),
    ()=>controller.action('refresh')]){
    start();
    assert.equal(controller.state().startup,'ready');
    t.mock.timers.tick(120000);
    assert.equal(controller.state().canRetry,false,'pending resources do not reactivate the launch shell');
    wc.emit('did-fail-load',{},-3,'cancelled','https://fixture.invalid/next',true);
    assert.equal(controller.state().startup,'ready');
  }
});

test('same-document and subframe events cannot interrupt the first-frame capture',async t=>{
  const {controller,wc}=fixture(t);
  wc.emit('did-finish-load');
  wc.emit('did-start-navigation',{isMainFrame:true,isSameDocument:true});
  wc.emit('did-start-navigation',{isMainFrame:false,isSameDocument:false});
  await Promise.resolve();
  assert.equal(controller.state().startup,'ready');
});

test('renderer loss returns to the shell and starts a new two-minute retry delay',async t=>{
  const {controller,wc}=fixture(t);
  wc.emit('did-finish-load');await Promise.resolve();
  wc.emit('render-process-gone');
  assert.equal(controller.state().startup,'error');
  assert.equal(controller.state().canRetry,false);
  t.mock.timers.tick(119999);assert.equal(controller.state().canRetry,false);
  t.mock.timers.tick(1);assert.equal(controller.state().canRetry,true);
  controller.action('refresh');wc.emit('did-finish-load');await Promise.resolve();
  assert.equal(controller.state().startup,'ready');
  assert.equal(controller.state().canRetry,false);
});
