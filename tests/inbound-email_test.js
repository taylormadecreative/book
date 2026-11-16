import {verifyInboundWebhook,parseReceivedEmail,handleInboundEmail,emailAddress,validInboundDomain} from '../supabase/functions/_shared/inbound-email.ts';
import {outgoingReplyTo} from '../supabase/functions/_shared/mail-delivery.ts';
const assert=(v,m='assertion failed')=>{if(!v)throw Error(m);};
const reject=async(fn)=>{try{await fn();}catch{return;}throw Error('expected rejection');};
const ID='11111111-1111-4111-8111-111111111111',ROUTE='22222222-2222-4222-8222-222222222222',DOMAIN='replies.example.test';
const SECRET='whsec_'+btoa('01234567890123456789012345678901'),NOW=1794844800000;
const payload=JSON.stringify({type:'email.received',data:{email_id:ID,text:'Forged webhook-body text is ignored'}});
async function headers(raw=payload,{secret=SECRET,ts=Math.floor(NOW/1000),id='msg_test'}={}){
  const key=await crypto.subtle.importKey('raw',Uint8Array.from(atob(secret.slice(6)),c=>c.charCodeAt(0)),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  const bytes=new Uint8Array(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(`${id}.${ts}.${raw}`)));
  return new Headers({'svix-id':id,'svix-timestamp':String(ts),'svix-signature':'v1,'+btoa(String.fromCharCode(...bytes))});
}
const email=(patch={})=>({id:ID,from:'Example Client <client@example.test>',to:[`reply+${ROUTE}@${DOMAIN}`],text:'The brief looks good.',headers:{'auto-submitted':'no'},authentication:{dkim:'pass',dmarc:'pass'},message_id:'<example@sender.test>',attachments:[],...patch});
Deno.test('Svix official verification vector, valid payload, rotation, forgery and timestamp bounds',async()=>{
  const sample='{"event_type":"ping","data":{"success":true}}';
  await verifyInboundWebhook(sample,new Headers({'svix-id':'msg_loFOjxBNrRLzqYUf','svix-timestamp':'1731705121','svix-signature':'v1,rAvfW3dJ/X/qxhsaXPOyyCGmRKsaKWcsNccKXlIktD0='}),'whsec_plJ3nmyCDGBKInavdOK15jsl',1731705121000);
  const good=await headers();await verifyInboundWebhook(payload,good,SECRET,NOW);
  good.set('svix-signature','v1,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA= '+good.get('svix-signature'));
  await verifyInboundWebhook(payload,good,SECRET,NOW);
  await reject(()=>verifyInboundWebhook(payload+' ',good,SECRET,NOW));
  await reject(()=>verifyInboundWebhook(payload,awaitHeadersForged(),SECRET,NOW));
  await reject(()=>verifyInboundWebhook(payload,good,SECRET,NOW+301000));
  await reject(()=>verifyInboundWebhook(payload,good,SECRET,NOW-301000));
  await reject(()=>verifyInboundWebhook(payload,good,'bad-secret',NOW));
});
function awaitHeadersForged(){return new Headers({'svix-id':'msg_test','svix-timestamp':String(Math.floor(NOW/1000)),'svix-signature':'v1,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='});}
Deno.test('addresses and domains reject injection and ambiguous sender identities',()=>{
  assert(emailAddress('Example <CLIENT@example.test>')==='client@example.test');
  assert(emailAddress('client@example.test\nBcc: other@example.test')===null);
  assert(emailAddress('one@example.test,two@example.test')===null);
  assert(validInboundDomain(' RePlies.Example.test ')==='replies.example.test');
  assert(validInboundDomain('https://example.test')===null&&validInboundDomain('bad..example.test')===null);
});
Deno.test('provider-fetched messages require authenticated sender and exact one reply route',()=>{
  const p=parseReceivedEmail(email(),DOMAIN,ID);assert(p.from==='client@example.test'&&p.routeToken===ROUTE&&p.body==='The brief looks good.');
  assert(parseReceivedEmail(email({authentication:{dkim:'fail',spf:'pass',dmarc:'fail'}}),DOMAIN,ID).skip==='sender_authentication_failed');
  assert(parseReceivedEmail(email({to:['reply+'+ROUTE+'@other.example.test']}),DOMAIN,ID).skip==='unmatched_recipient');
  assert(parseReceivedEmail(email({to:[`reply+${ROUTE}@${DOMAIN}`,`reply+33333333-3333-4333-8333-333333333333@${DOMAIN}`]}),DOMAIN,ID).skip==='unmatched_recipient');
  assert(parseReceivedEmail(email({id:'other'}),DOMAIN,ID).skip==='provider_id_mismatch');
});
Deno.test('automatic responses/bounces skip; plain-text extraction ignores scripts and attachments',()=>{
  for(const patch of [{headers:{'auto-submitted':'auto-replied'}},{headers:{'x-autoreply':'yes'}},{headers:{'content-type':'multipart/report; report-type=delivery-status'}},{from:'mailer-daemon@example.test'}])assert(parseReceivedEmail(email(patch),DOMAIN,ID).skip==='automatic_message');
  const p=parseReceivedEmail(email({text:null,html:'<style>bad</style><script>alert(1)</script><p>Thanks &amp; yes.</p><img src="https://never-fetch.example.test/img">',attachments:[{url:'https://never-fetch.example.test/file'}]}),DOMAIN,ID);
  assert(p.body==='Thanks & yes.');
  assert(parseReceivedEmail(email({text:'x'.repeat(9000)}),DOMAIN,ID).body.length===4000);
  assert(parseReceivedEmail(email({text:null,html:null,attachments:[{id:'file'}]}),DOMAIN,ID).body.includes('Attachments are not imported'));
});
Deno.test('handler fails closed when not configured or forged, and never fetches unverified content',async()=>{
  let reads=0,writes=0;const deps={domain:DOMAIN,secret:SECRET,apiKey:'fake',db:{rpc:async()=>{writes++;return {data:{},error:null};}},fetch:async()=>{reads++;return new Response(JSON.stringify(email()));},now:NOW};
  assert((await handleInboundEmail(new Request('https://test',{method:'POST',body:payload}),deps)).status===401);
  assert(reads===0&&writes===0);
  assert((await handleInboundEmail(new Request('https://test',{method:'POST',body:payload}),{...deps,secret:undefined})).status===503);
  assert(reads===0&&writes===0);
});
Deno.test('receiver accepts existing aliases with outgoing gate off and exposes no routing result',async()=>{
  const calls=[],reads=[];
  const fallback=await outgoingReplyTo({fallback:'studio@example.test',projectId:ID,kind:'studio_reply',domain:DOMAIN,enabled:'false'},()=>{throw Error('Outgoing route must stay disabled');});
  assert(fallback==='studio@example.test');
  const deps={domain:DOMAIN,secret:SECRET,apiKey:'fake',db:{rpc:async(name,args)=>{calls.push({name,args});return {data:{ok:true,status:'received'},error:null};}},fetch:async(url,opts)=>{reads.push({url,opts});return new Response(JSON.stringify(email()));},now:NOW};
  const res=await handleInboundEmail(new Request('https://test',{method:'POST',body:payload,headers:await headers()}),deps);
  assert(res.status===200&&JSON.stringify(await res.json())==='{"ok":true}');
  assert(reads.length===1&&reads[0].url===`https://api.resend.com/emails/receiving/${ID}?html_format=cid`);
  assert(reads[0].opts.headers.Authorization==='Bearer fake');
  assert(calls.length===1&&calls[0].name==='bk_crm_ingest_email'&&calls[0].args.p_body==='The brief looks good.');
  assert(!calls[0].args.p_body.includes('Forged'));
});
Deno.test('held authentication/sender failures create a visible review without importing body',async()=>{
  const calls=[];
  const deps={domain:DOMAIN,secret:SECRET,apiKey:'fake',db:{rpc:async(name,args)=>{calls.push({name,args});return {data:{status:'ignored'},error:null};}},fetch:async()=>new Response(JSON.stringify(email({authentication:null}))),now:NOW};
  const req=async()=>new Request('https://test',{method:'POST',body:payload,headers:await headers()});
  let res=await handleInboundEmail(await req(),deps);
  assert(res.status===200&&calls.length===1&&calls[0].name==='bk_crm_note_email'&&calls[0].args.p_reason==='sender_authentication_failed');
  assert(!Object.hasOwn(calls[0].args,'p_body'));
  calls.length=0;
  res=await handleInboundEmail(await req(),{...deps,fetch:async()=>new Response(JSON.stringify(email()))});
  assert(res.status===200&&calls.length===2&&calls[1].name==='bk_crm_note_email'&&calls[1].args.p_reason==='sender_mismatch');
  assert(JSON.stringify(await res.json())==='{"ok":true}');
});
Deno.test('retryable provider/database errors remain generic and oversized webhook never fetches',async()=>{
  const deps={domain:DOMAIN,secret:SECRET,apiKey:'fake',db:{rpc:async()=>({error:{message:'PRIVATE DATABASE DETAIL'}})},fetch:async()=>new Response(JSON.stringify(email())),now:NOW};
  let res=await handleInboundEmail(new Request('https://test',{method:'POST',body:payload,headers:await headers()}),deps);
  assert(res.status===500&&!(await res.text()).includes('PRIVATE'));
  res=await handleInboundEmail(new Request('https://test',{method:'POST',body:payload,headers:await headers()}),{...deps,fetch:async()=>new Response('PRIVATE',{status:500})});assert(res.status===502);
  let fetched=false;const big='x'.repeat(65537);
  res=await handleInboundEmail(new Request('https://test',{method:'POST',body:big,headers:await headers(big)}),{...deps,fetch:async()=>{fetched=true;throw Error('not called');}});
  assert(res.status===401&&!fetched);
});
