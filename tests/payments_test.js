import { checkout, reconcileEvent } from "../supabase/functions/_shared/payment-core.ts";
const assert=(v,msg="assertion failed")=>{if(!v)throw new Error(msg);};
const ID="11111111-1111-4111-8111-111111111111", PROJECT="22222222-2222-4222-8222-222222222222", TOKEN="33333333-3333-4333-8333-333333333333";
const request=(body={invoice_id:ID,token:TOKEN})=>new Request("https://local.test/checkout",{method:"POST",body:JSON.stringify(body),headers:{"Content-Type":"application/json"}});
function rig({provider="stripe",legacy=null,balance=null,saveFailures=0}={}) {
 const state={attempt:null,objects:new Map(),created:0,calls:[],saved:0,failRead:false};
 const inv={id:ID,project_id:PROJECT,status:"sent",kind:balance?"deposit":"full",amount_cents:10000,line_items:[{title:"Synthetic session"}],
  bk_projects:{id:PROJECT,access_token:TOKEN,client_email:"synthetic@example.test",billing_provider:provider,external_billing_url:provider==="honeybook"?"https://studio.hbportal.co/invoice/test":null}};
 const db={
  from(table){const result=()=>({data:table==="bk_invoices"?inv:balance,error:null});const builder={
    select(){return this;},eq(){return this;},single:async()=>result(),maybeSingle:async()=>result()
  };return builder;},
  async rpc(name,args){
   if(name==="bk_prepare_checkout"){
    state.attempt??={id:"attempt-test",params:{...args.p_params,expires_at:9999999999},legacy_session_id:legacy};
    return {data:structuredClone(state.attempt),error:null};
   }
   if(name==="bk_finish_checkout"){
    state.saved++;
    if(state.saved<=saveFailures)return {data:null,error:{message:"temporary persistence failure"}};
    state.attempt.stripe_session_id=args.p_session;return {data:true,error:null};
   }
   throw new Error("unexpected RPC "+name);
  }
 };
 const stripe={checkout:{sessions:{
  async retrieve(id){if(state.failRead)throw {code:"api_connection_error"};return state.objects.get(id)??{id,status:"expired"};},
  async expire(id){const s=state.objects.get(id);if(s)s.status="expired";return s;},
  async create(params,options){
   state.calls.push({params:structuredClone(params),key:options.idempotencyKey});
   if(!state.objects.has(options.idempotencyKey)){state.created++;state.objects.set(options.idempotencyKey,{id:"cs_"+state.created,url:"https://checkout.stripe.test/"+state.created,status:"open"});}
   const obj=state.objects.get(options.idempotencyKey);state.objects.set(obj.id,obj);return obj;
  }
 }}};
 return {db,stripe,state,inv};
}
Deno.test("concurrent checkout requests share one Stripe idempotency key and canonical parameters",async()=>{
 const r=rig();const [a,b]=await Promise.all([checkout(request(),r),checkout(request({...{invoice_id:ID,token:TOKEN},return_url:"https://jenelstudios.com/thanks"}),r)]);
 assert(a.status===200&&b.status===200);assert(r.state.created===1,"only one Stripe object");
 assert(r.state.calls[0].key===r.state.calls[1].key,"same random attempt ID");
 assert(JSON.stringify(r.state.calls[0].params)===JSON.stringify(r.state.calls[1].params),"parameters do not drift between concurrent return URLs");
});
Deno.test("crash after Stripe create retries the same object and returns URL only after persistence",async()=>{
 const r=rig({saveFailures:1});
 assert((await checkout(request(),r)).status===503,"failed save cannot report success");
 assert((await checkout(request(),r)).status===200);assert(r.state.created===1,"retry cannot make second payable session");
});
Deno.test("HoneyBook and unassigned projects cannot create Stripe checkout",async()=>{
 for(const provider of ["honeybook","unassigned"]){
  const r=rig({provider});const out=await checkout(request(),r);const body=await out.json();
  assert(out.status===409);assert(r.state.calls.length===0);
  assert(body.error===(provider==="honeybook"?"external_payment_required":"billing_provider_required"));
 }
});
Deno.test("HoneyBook route never forwards a mislabeled Stripe payment URL",async()=>{
 const r=rig({provider:"honeybook"});r.inv.bk_projects.external_billing_url="https://checkout.stripe.com/pay/example";
 const out=await checkout(request(),r);assert((await out.json()).url===null);assert(r.state.created===0);
});
Deno.test("failed legacy session retrieval never creates a fresh payable session",async()=>{
 const r=rig({legacy:"cs_legacy"});r.state.failRead=true;
 assert((await checkout(request(),r)).status===503);assert(r.state.created===0);
});
Deno.test("legacy open session expires before a replacement is created",async()=>{
 const r=rig({legacy:"cs_legacy"});r.state.objects.set("cs_legacy",{id:"cs_legacy",status:"open",url:"https://checkout.stripe.test/legacy"});
 assert((await checkout(request(),r)).status===200);
 assert(r.state.objects.get("cs_legacy").status==="expired");assert(r.state.created===1);
});
Deno.test("completed legacy async session never creates a second checkout while payment settles",async()=>{
 const r=rig({legacy:"cs_legacy"});r.state.objects.set("cs_legacy",{id:"cs_legacy",status:"complete",payment_status:"unpaid"});
 const out=await checkout(request(),r);assert(out.status===409);assert((await out.json()).error==="payment_processing");
 assert(r.state.created===0);
});
Deno.test("deployed saved-card and automatic balance consent survive checkout hardening",async()=>{
 const r=rig({balance:{balance_cents:15000,balance_status:"scheduled",starts_at:"2030-01-05T16:00:00Z"}});
 assert((await checkout(request(),r)).status===200);
 const p=r.state.calls[0].params;
 assert(p.customer_creation==="always");assert(p.payment_intent_data.setup_future_usage==="off_session");
 assert(p.payment_method_types[0]==="card");assert(p.custom_text.submit.message.includes("$150"));
});
Deno.test("malformed token is rejected before database or Stripe access",async()=>{
 const r=rig();assert((await checkout(request({invoice_id:ID,token:"invalid"}),r)).status===400);
 assert(r.state.calls.length===0&&r.state.attempt===null);
});
Deno.test("webhook persistence errors request retry and async unsettled sessions do not mark paid",async()=>{
 let writes=0;const db={from(){throw new Error("unexpected direct table write");},async rpc(){writes++;return {data:null,error:{message:"temporary"}};}};
 const event={id:"evt_test",type:"checkout.session.completed",data:{object:{payment_status:"unpaid"}}};
 assert(await reconcileEvent(event,db));assert(writes===0);
 event.data.object.payment_status="paid";assert(!await reconcileEvent(event,db));assert(writes===1);
});
Deno.test("webhook acknowledges only durably applied, duplicate or attention results",async()=>{
 for(const status of ["applied","duplicate","attention","processing"]){
  const db={from(){throw new Error("unexpected write");},async rpc(){return {data:{status},error:null};}};
  assert((await reconcileEvent({id:"evt_test",type:"checkout.session.async_payment_succeeded",data:{object:{}}},db))===(status!=="processing"));
 }
});
