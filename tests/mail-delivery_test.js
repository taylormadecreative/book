import { assertEquals } from 'jsr:@std/assert@1';
import { deliverMail, outgoingReplyTo } from '../supabase/functions/_shared/mail-delivery.ts';
const request={from:'Studio <studio@example.test>',to:['client@example.test'],reply_to:'reply+example@inbound.example.test',subject:'Sample',html:'<p>Sample message</p>'};
Deno.test('mail retries retain the same idempotency key and exact request',async()=>{
  const calls=[];const transport=(_url,options)=>{calls.push(options);return Promise.resolve(new Response('{}',{status:200}));};
  assertEquals(await deliverMail(request,'synthetic-id','synthetic-key',transport),null);
  assertEquals(await deliverMail(request,'synthetic-id','synthetic-key',transport),null);
  assertEquals(calls[0].headers['Idempotency-Key'],'bk-queue/synthetic-id');
  assertEquals(calls[0].body,calls[1].body);
});
Deno.test('mail configuration and recipient failures do not send',async()=>{
  let count=0;const transport=()=>{count++;return Promise.resolve(new Response('{}'));};
  assertEquals(await deliverMail(request,'id',undefined,transport),'RESEND_API_KEY not set');
  assertEquals(await deliverMail({...request,to:['']},'id','key',transport),'A valid recipient email is required');
  assertEquals(count,0);
});
Deno.test('provider failures remain actionable',async()=>{
  assertEquals(await deliverMail(request,'id','key',()=>Promise.resolve(new Response('Rate limit',{status:429}))),'resend 429: Rate limit');
});
Deno.test('receiving configuration alone never enables outgoing reply aliases',async()=>{
  let routed=0;
  const config={fallback:'studio@example.test',projectId:'11111111-1111-4111-8111-111111111111',kind:'studio_reply',domain:'replies.example.test'};
  const route=()=>{routed++;return Promise.resolve({data:'reply+22222222-2222-4222-8222-222222222222@replies.example.test',error:null});};
  for(const enabled of [undefined,'','false','TRUE','1'])assertEquals(await outgoingReplyTo({...config,enabled},route),config.fallback);
  assertEquals(routed,0);
  assertEquals(await outgoingReplyTo({...config,enabled:'true'},route),'reply+22222222-2222-4222-8222-222222222222@replies.example.test');
  assertEquals(routed,1);
  assertEquals(await outgoingReplyTo({...config,enabled:'true',kind:'nelson_alert'},route),config.fallback);
  assertEquals(routed,1);
  assertEquals(await outgoingReplyTo({...config,enabled:'false'},route),config.fallback);
  assertEquals(routed,1);
});
Deno.test('enabled but invalid reply routing fails before a send is attempted',async()=>{
  const config={fallback:'studio@example.test',projectId:'11111111-1111-4111-8111-111111111111',kind:'studio_reply',enabled:'true',domain:undefined};
  let count=0;const route=()=>{count++;return Promise.resolve({data:null,error:{message:'private'}});};
  let failed=false;try{await outgoingReplyTo(config,route);}catch{failed=true;}assertEquals(failed,true);assertEquals(count,0);
  failed=false;try{await outgoingReplyTo({...config,domain:'replies.example.test'},route);}catch{failed=true;}assertEquals(failed,true);assertEquals(count,1);
});
