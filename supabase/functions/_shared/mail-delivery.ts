import { validInboundDomain } from './inbound-email.ts';
export type MailRequest = { from:string; to:string[]; reply_to:string; subject:string; html:string };
// Project secrets are shared across Supabase functions. Configuring receiving
// must not enable outgoing aliases until the separate activation switch is true.
export async function outgoingReplyTo(config:{fallback:string;projectId:string|null|undefined;kind:string;enabled:string|undefined;domain:string|undefined},route:(projectId:string,domain:string)=>PromiseLike<{data:unknown;error:unknown}>):Promise<string> {
  if(config.enabled!=='true'||!config.projectId||config.kind==='nelson_alert')return config.fallback;
  const domain=validInboundDomain(config.domain);
  if(!domain)throw Error('CRM incoming email domain is not configured');
  const result=await route(config.projectId,domain);
  if(result.error||typeof result.data!=='string'||!/^reply\+[0-9a-f-]{36}@/i.test(result.data)||!result.data.endsWith('@'+domain)||/[\r\n]/.test(result.data))throw Error('CRM email reply route unavailable');
  return result.data;
}
// The caller persists this exact request before the first attempt. A stable
// queue ID and body make concurrent attempts/retries safe in Resend's 24h window.
export async function deliverMail(request:MailRequest, queueId:string, apiKey:string|undefined, fetcher:typeof fetch=fetch):Promise<string|null> {
  if(!apiKey) return 'RESEND_API_KEY not set';
  if(!request.to.length || request.to.some(to=>!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to))) return 'A valid recipient email is required';
  const response=await fetcher('https://api.resend.com/emails',{
    method:'POST',headers:{authorization:`Bearer ${apiKey}`,'content-type':'application/json','Idempotency-Key':`bk-queue/${queueId}`},
    body:JSON.stringify(request),
  });
  if(!response.ok) return `resend ${response.status}: ${(await response.text()).slice(0,300)}`;
  return null;
}
