// Resend's signed email.received webhook. Deploy with verify_jwt=false.
// Remains disabled until domain receiving + webhook secrets are configured.
import { createClient } from 'npm:@supabase/supabase-js@2.119.0';
import { handleInboundEmail } from '../_shared/inbound-email.ts';
Deno.serve(async(req:Request)=>{
  const domain=Deno.env.get('CRM_INBOUND_DOMAIN');
  const secret=Deno.env.get('RESEND_WEBHOOK_SECRET');
  const apiKey=Deno.env.get('RESEND_API_KEY');
  const url=Deno.env.get('SUPABASE_URL'),serviceKey=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if(!url||!serviceKey)return new Response(JSON.stringify({error:'inbound_not_configured'}),{status:503,headers:{'Content-Type':'application/json'}});
  return await handleInboundEmail(req,{domain,secret,apiKey,db:createClient(url,serviceKey,{auth:{persistSession:false}})});
});
