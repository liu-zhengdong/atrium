const { chromium } = require('playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const dir = process.env.ATRIUM_WEB_BROWSER_TEST;
if (!dir) throw Error('ATRIUM_WEB_BROWSER_TEST 必须指向临时交接目录');
const pause = ms => new Promise(r => setTimeout(r, ms));
(async () => {
 let info;
 for (let i=0;i<100;i++) { try { info=JSON.parse(await fs.readFile(path.join(dir,'ready.json'),'utf8')); break; } catch { await pause(100); } }
 if (!info) throw Error('隔离网页未就绪');
 const shots=path.join(dir,'成品'); await fs.mkdir(shots,{recursive:true});
 const api = async p => { const r=await fetch(info.base+'/ui/api/'+p); assert.equal(r.status,200); const d=await r.json();assert.equal(d.ok,true);return d.result; };
 const browser=await chromium.launch({headless:true});
 const report=[]; const errors=[];
 try {
 const context=await browser.newContext({viewport:{width:1280,height:900},deviceScaleFactor:2});
 const page=await context.newPage(); page.on('pageerror',e=>errors.push(e.message));
 const read = async (hash,selector,expected) => {
  await page.goto(info.base+'/'+hash); await page.locator(selector).first().waitFor();
  await page.waitForFunction(({selector,expected})=>document.querySelector(selector)?.textContent.includes(expected),{selector,expected});
  await pause(300);
 };
 const nav=await api('nav'); assert.equal(nav.names.a1,'负责人1');assert.equal(nav.names.a10,'负责人10');
 const schema = d => Array.isArray(d) ? ['array',...d.map(schema)] : d && typeof d==='object' ? Object.fromEntries(Object.entries(d).map(([k,v])=>[k,schema(v)])) : typeof d;
 const paths=['nav','today','dept/'+info.dept,'task/'+info.task,'task/'+info.draft,'task/'+info.unknown,'choice/'+info.choice,'schedule/'+info.schedule];
 const before=await Promise.all(paths.map(api));
 assert.equal(before[3].holder,'负责人10（a10）：待分派');
 assert.equal(before[4].by_name,'负责人1（a1）');assert.equal(before[5].by_name,'未登记负责人（a99）');
 const routes=[
  ['部门','#'+info.dept,'.lead','a10'],
  ['负责人','#'+info.dept+'/a10','#drawer h3','a10'],
  ['等待','#'+info.dept+'/'+info.task,'.holder','a10'],
  ['来源','#'+info.dept+'/'+info.draft,'.facts','a1'],
  ['未登记','#'+info.dept+'/'+info.unknown,'.facts','a99'],
  ['选项','#today/'+info.choice,'#drawer .sub-t','a1'],
  ['定时','#'+info.dept+'/'+info.schedule,'#drawer .sub-t','a10'],
  ['规矩','#'+info.dept+'/rules','.rule','a1'],
  ['资料','#'+info.dept+'/files/'+info.material,'#drawer .sub-t','a1'],
  ['上报','#today','#page','a1'],
 ];
 for (const mode of ['标准','长名']) {
  if(mode==='长名') {
   await read('#'+info.dept+'/a10','#drawer h3','负责人10（a10）');
   await fs.writeFile(path.join(dir,'rename.json'),JSON.stringify({a1:'负责整体协调与长期改进的负责人<&"',a10:'负责网页命令呈现与用户理解的负责人非常长名字'}));
   for(let i=0;i<100;i++){try{await fs.access(path.join(dir,'renamed'));break;}catch{await pause(100);}}
   // 不重新加载文档：名册下一次读取应使缓存页和抽屉一起更新。
   await page.evaluate(()=>route());
   await page.waitForFunction(()=>document.querySelector('#drawer h3')?.textContent.includes('非常长名字（a10）'));
   assert.ok((await page.locator('.lead').textContent()).includes('非常长名字（a10）'));
   const after=await Promise.all(paths.map(api));
   assert.deepEqual(after.map(schema),before.map(schema));
   assert.equal(after[4].by_lead,before[4].by_lead);
   assert.equal(after[3].task.detail,'a1 历史原文不能被改名');
   assert.equal(after[6].created_by,'a1');assert.equal(after[7].by,'a10');
  }
  for(const width of [1280,390]) for(const theme of ['light','dark']) {
   await page.setViewportSize({width,height:900});await page.emulateMedia({colorScheme:theme});
   for(const [label,hash,selector,id] of routes) {
    const names=(await api('nav')).names;
    const expected=id==='a99'?'未登记负责人（a99）':names[id]+'（'+id+'）';
    await read(hash,selector,expected);
    const overflow=await page.evaluate(()=> {
     const els=[document.documentElement,document.querySelector('#scroll'),...(document.querySelector('#island').classList.contains('open')?[document.querySelector('.dbody')]:[])];
     return els.filter(e=>e && e.scrollWidth>e.clientWidth+1).map(e=>({class:e.className,scroll:e.scrollWidth,client:e.clientWidth}));
    });
    const splitIDs=await page.evaluate(()=> {
     const root=document.querySelector('#island').classList.contains('open')?document.querySelector('#drawer'):document.querySelector('#page');
     const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);let node;const bad=[];
     while(node=walker.nextNode()) for(const match of node.textContent.matchAll(/（a[1-9][0-9]*）/g)) {
      const range=document.createRange();range.setStart(node,match.index);range.setEnd(node,match.index+match[0].length);
      if(range.getClientRects().length>1) bad.push(match[0]);
     }
     return bad;
    });
    assert.deepEqual(splitIDs,[],`${mode}/${width}/${theme}/${label} 括号短号拆行`);
    assert.deepEqual(overflow,[],`${mode}/${width}/${theme}/${label} 横向溢出`);
    if(label==='来源') {
     const href=await page.locator('.facts a').getAttribute('href');assert.equal(href,'#'+info.root+'/a1');
     await page.locator('.facts a').click();await page.waitForFunction(()=>document.querySelector('#drawer h3')?.textContent.includes('（a1）'));
    }
    if(label==='规矩') assert.ok((await page.locator('#page').textContent()).includes('a1 历史原文'));
    if(label==='资料') { assert.equal((await page.locator('#viewer').textContent()).trim(),'a1 历史原文保持');assert.equal(await page.locator('#drawer .sub-t script').count(),0); }
    if(label==='上报') assert.equal(await page.locator('.ask.escalate .s').evaluate(e=>e.scrollWidth>e.clientWidth),false);
    if(label==='部门') { await page.locator('.lead').click();await page.waitForFunction(()=>location.hash.endsWith('/a10'));await page.waitForFunction(()=>document.querySelector('#drawer h3')?.textContent.includes('（a10）')); }
    if(label==='部门') await read(hash,selector,expected);
    report.push(`${mode}/${width}/${theme}/${label}:通过`);
    if(['部门','等待','规矩','资料','上报'].includes(label)) await page.screenshot({path:path.join(shots,`${mode}-${width}-${theme}-${label}.png`)});
   }
  }
 }
 assert.deepEqual(errors,[]);
 await fs.writeFile(path.join(dir,'report.json'),JSON.stringify({checks:report.length,errors,report},null,2));
 console.log(`实际网页 ${report.length} 屏通过；2倍、1280/390px、明暗、长名、HTML名字、改名刷新、JSON结构与原ID、原文及链接回归通过`);
 } finally { await browser.close();await fs.writeFile(path.join(dir,'done'),'ok'); }
})().catch(e=>{console.error(e);process.exitCode=1;});
