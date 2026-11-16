import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const port=18769,base=`http://127.0.0.1:${port}`;
const server=spawn('python3',['-m','http.server',String(port),'--bind','127.0.0.1'],{cwd:fileURLToPath(new URL('..',import.meta.url)),stdio:'ignore'});
let browser;
const session={access_token:'synthetic-token',refresh_token:'synthetic-refresh',expires_at:Math.floor(Date.now()/1000)+3600,user:{id:'11111111-1111-4111-8111-111111111111',email:'staff@example.test',aud:'authenticated',role:'authenticated'}};
const project={id:'22222222-2222-4222-8222-222222222222',access_token:'33333333-3333-4333-8333-333333333333',client_name:'Sample Customer',client_email:'client@example.test',service:'photography',title:'Sample project',status:'quoted',billing_provider:'stripe',created_at:new Date().toISOString(),updated_at:new Date().toISOString(),notes_internal:'Original note',bk_invoices:[{id:'invoice-1',title:'Sample deposit',kind:'deposit',amount_cents:10000,status:'sent'}],bk_messages:[],bk_files:[],bk_galleries:[]};
try {
  await new Promise(r=>setTimeout(r,500));
  browser=await chromium.launch(process.env.PW_CHROME?{executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'}:{});
  const context=await browser.newContext();
  await context.addInitScript(s=>localStorage.setItem('sb-pgqdmnmessbbzyszjfvr-auth-token',JSON.stringify(s)),session);
  await context.route(/fonts\.(googleapis|gstatic)\.com/,r=>r.fulfill({status:200,body:''}));
  await context.route('**/pgqdmnmessbbzyszjfvr.supabase.co/**',async r=>{
    const u=r.request().url(),method=r.request().method();
    const json=(b,status=200)=>r.fulfill({status,contentType:'application/json',body:JSON.stringify(b)});
    if(u.includes('/auth/'))return json(session.user);
    if(u.includes('/bk_projects'))return json(method==='PATCH'?[]:[project]);
    if(u.includes('/bk_invoices')&&method==='PATCH')return json([]);
    if(u.includes('/bk_files')&&method==='POST')return json({message:'Synthetic write denied'},403);
    if(u.includes('/bk_contracts'))return json([]);
    return json([]);
  });
  const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`${base}/admin.html?p=${project.id}`);
  await page.locator('#noteBox').waitFor();
  await page.locator('#noteBox').fill('Keep these unsaved changes');
  await page.locator('#noteSave').click();
  await page.waitForFunction(()=>document.querySelector('#toast').textContent.includes("Couldn't save"));
  assert.equal(await page.locator('#noteBox').inputValue(),'Keep these unsaved changes');
  await page.locator('[data-inv-paid]').click();
  assert(!/Marked paid/.test(await page.locator('#toast').textContent()));
  await page.locator('#statusSel').selectOption('booked');
  await page.waitForFunction(()=>document.querySelector('#statusSel').value==='quoted');
  await page.locator('#fileLabel').fill('Sample files');await page.locator('#fileUrl').fill('https://example.test/files');await page.locator('#fileAdd').click();
  assert.equal(await page.locator('#fileLabel').inputValue(),'Sample files');
  assert.deepEqual(errors,[]);await context.close();

  for(const width of [1512,390]) {
    const ctx=await browser.newContext({viewport:{width,height:900}});const calls=[];let accepted=false,attempts=0;
    await ctx.route(/fonts\.(googleapis|gstatic)\.com/,r=>r.fulfill({status:200,body:''}));
    await ctx.route('**/js/gallery-core.js*',r=>r.fulfill({status:200,contentType:'application/javascript',body:'window.BKGallery={mount:async()=>({}),list:async()=>({projects:[]})};'}));
    await ctx.route('**/pgqdmnmessbbzyszjfvr.supabase.co/**',async r=>{
      const u=r.request().url(),b=JSON.parse(r.request().postData()||'{}');
      const json=(v,status=200)=>r.fulfill({status,contentType:'application/json',body:JSON.stringify(v)});
      if(u.endsWith('/bk_portal'))return json({project,invoices:[],messages:[],contracts:[],files:[]});
      if(u.endsWith('/bk_extra_edit_cents'))return json(0);
      if(u.endsWith('/bk_crm_portal_billing'))return json({billing_provider:'unassigned',external_billing_url:null});
      if(u.endsWith('/bk_crm_portal_quotes'))return json({rows:[{id:'quote-1',version:'version-1',title:'Sample <img src=x onerror=window.pwned=1> quote',status:accepted?'accepted':'sent',lines:[{description:'Studio session',quantity:1,unit_cents:25000}],total_cents:25000,notes:'One session, three edited images.',accepted_by:accepted?'Sample Signer':null,accepted_at:accepted?new Date().toISOString():null}]});
      if(u.endsWith('/bk_crm_accept_quote')) { calls.push(b);if(++attempts===1)return json({message:'Synthetic offline failure'},500);accepted=true;return json({ok:true,status:'accepted'}); }
      throw Error(`Unexpected service call: ${u}`);
    });
    const p=await ctx.newPage();const errs=[];p.on('pageerror',e=>errs.push(e.message));
    await p.goto(`${base}/portal.html?p=${project.id}&t=${project.access_token}`);
    await p.locator('[data-quote-form]').waitFor();
    assert.equal(await p.evaluate(()=>Boolean(window.pwned)),false);
    assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    const form=p.locator('[data-quote-form]');await form.locator('[name=signer]').fill('Sample Signer');
    await form.locator('button').click();assert.equal(calls.length,0,'approval requires explicit checkbox');
    await form.locator('[name=agree]').check();await form.locator('button').click();
    await form.locator('[role=alert]').waitFor({state:'visible'});assert.equal(await form.locator('[name=signer]').inputValue(),'Sample Signer');
    await form.locator('button').click();await p.locator('.quote-document .ct-signed').waitFor();
    assert.equal(calls.at(-1).p_version,'version-1');assert.equal(calls.at(-1).p_quote,'quote-1');assert.equal(calls.at(-1).p_token,project.access_token);
    assert.deepEqual(errs,[]);await ctx.close();
  }
  console.log('foundation-ui.e2e: refused saves preserve forms; desktop/phone quote consent, retry, version and escaping passed');
} finally { await browser?.close(); server.kill(); }
