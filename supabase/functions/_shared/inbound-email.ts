// Provider-specific inbound boundary. No SDK, HTML execution, or media downloads.
// Protocol: https://docs.svix.com/receiving/verifying-payloads/how-manual
// Content: https://resend.com/docs/api-reference/emails/retrieve-received-email
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DOMAIN=/^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,63}$/;
const enc=new TextEncoder();
export function validInboundDomain(value: unknown): string|null {
  const d=String(value??'').trim().toLowerCase();
  return DOMAIN.test(d) && !d.includes('..') ? d : null;
}
export function emailAddress(value: unknown): string|null {
  if(typeof value!=='string'||value.length>400||/[\r\n]/.test(value))return null;
  const m=value.trim().match(/^(?:[^<>]*<([^<>]+)>|([^<>\s]+))$/);
  const email=(m?.[1]??m?.[2]??'').trim().toLowerCase();
  return /^[^@\s,;]+@[^@\s,;]+\.[^@\s,;]+$/.test(email)&&email.length<=200?email:null;
}
function base64(value:string):Uint8Array<ArrayBuffer> {
  if(!/^[A-Za-z0-9+/]+={0,2}$/.test(value))throw Error('invalid_base64');
  const raw=atob(value),out=new Uint8Array(raw.length);for(let i=0;i<raw.length;i++)out[i]=raw.charCodeAt(i);return out;
}
export async function verifyInboundWebhook(raw:string,headers:Headers,secret:string,nowMs=Date.now()):Promise<void> {
  const id=headers.get('svix-id')??'',ts=headers.get('svix-timestamp')??'',signatures=headers.get('svix-signature')??'';
  if(!/^[A-Za-z0-9_-]{1,200}$/.test(id)||!/^\d{1,12}$/.test(ts)||Math.abs(nowMs/1000-Number(ts))>300||signatures.length>2000||!secret.startsWith('whsec_'))throw Error('invalid_webhook');
  let key:CryptoKey;
  try { const bytes=base64(secret.slice(6));if(bytes.length<16)throw Error('short_secret');key=await crypto.subtle.importKey('raw',bytes,{name:'HMAC',hash:'SHA-256'},false,['verify']); }catch{throw Error('invalid_webhook');}
  const payload=enc.encode(`${id}.${ts}.${raw}`);
  for(const signature of signatures.trim().split(/\s+/)) {
    const [version,value,...rest]=signature.split(',');if(version!=='v1'||!value||rest.length)continue;
    try { const bytes=base64(value);if(bytes.length===32&&await crypto.subtle.verify('HMAC',key,bytes,payload))return; }catch{/* try remaining rotation signatures */}
  }
  throw Error('invalid_webhook');
}
export async function boundedText(response:Request|Response,maxBytes:number):Promise<string> {
  const declared=Number(response.headers.get('content-length')??0);if(declared>maxBytes)throw Error('body_too_large');
  if(!response.body)return '';
  const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0;
  try { while(true){const {value,done}=await reader.read();if(done)break;if(value){size+=value.byteLength;if(size>maxBytes)throw Error('body_too_large');chunks.push(value);}} }
  finally {await reader.cancel().catch(()=>{});}
  const out=new Uint8Array(size);let offset=0;for(const x of chunks){out.set(x,offset);offset+=x.byteLength;}
  return new TextDecoder('utf-8',{fatal:true}).decode(out);
}
function plainHtml(html:string):string {
  return html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,'').replace(/<!--[\s\S]*?-->/g,'')
    .replace(/<(?:br\b[^>]*|\/(?:p|div|li|tr|h[1-6]))>/gi,'\n').replace(/<[^>]*>/g,'')
    .replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi,(_,entity:string)=>{
      const k=entity.toLowerCase();const known:Record<string,string>={amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:' '};
      if(known[k]!==undefined)return known[k];const n=parseInt(k.startsWith('#x')?k.slice(2):k.slice(1),k.startsWith('#x')?16:10);
      return n>0&&n<=0x10ffff&&!(n>=0xd800&&n<=0xdfff)?String.fromCodePoint(n):'';
    });
}
type Email=Record<string,any>;
export function parseReceivedEmail(email:Email,domain:string,expectedId:string): {skip?:string;routeToken?:string;from?:string;body?:string;messageId?:string|null} {
  if(email.id!==expectedId)return {skip:'provider_id_mismatch'};
  const routes=(Array.isArray(email.to)?email.to:[]).map(emailAddress).filter((v):v is string=>typeof v==='string'&&v.endsWith('@'+domain)).map(v=>v.slice(0,-domain.length-1)).filter(v=>v.startsWith('reply+')&&UUID.test(v.slice(6)));
  const distinct=[...new Set<string>(routes)];if(distinct.length!==1)return {skip:'unmatched_recipient'};
  const routeToken=distinct[0].slice(6).toLowerCase();
  const from=emailAddress(email.from);if(!from)return {skip:'invalid_sender',routeToken};
  const headers:Record<string,string>={};
  if(email.headers&&typeof email.headers==='object'&&!Array.isArray(email.headers))for(const [k,v] of Object.entries(email.headers))headers[k.toLowerCase()]=String(v).toLowerCase();
  if((headers['auto-submitted']&&headers['auto-submitted']!=='no')||headers['x-autoreply']||headers['x-autorespond']||/^(bulk|junk|list)$/.test(headers.precedence??'')||/multipart\/report|report-type\s*=\s*delivery-status/.test(headers['content-type']??'')||/^(mailer-daemon|postmaster)@/.test(from))return {skip:'automatic_message',routeToken,from};
  // These results are computed by Resend's receiving server, not sender headers.
  if(email.authentication?.dmarc!=='pass'&&email.authentication?.dkim!=='pass')return {skip:'sender_authentication_failed',routeToken,from};
  let text=typeof email.text==='string'?email.text.trim():'';
  if(!text&&typeof email.html==='string')text=plainHtml(email.html).trim();
  text=text.replace(/\u0000/g,'').replace(/\r\n?/g,'\n').trim();
  if(!text&&Array.isArray(email.attachments)&&email.attachments.length)text='[Email contains attachments without readable message text. Review the original in your email inbox. Attachments are not imported.]';
  if(!text)return {skip:'empty_message',routeToken,from};
  const suffix='\n\n[Reply clipped at 4,000 characters. Review the original email for the full message.]';
  if(text.length>4000)text=text.slice(0,4000-suffix.length)+suffix;
  // Metadata only; never follow raw/attachment URLs or render received HTML.
  const messageId=typeof email.message_id==='string'&&email.message_id.length<=1000?email.message_id.trim()||null:null;
  return {routeToken,from,body:text,messageId};
}
export async function handleInboundEmail(req:Request,deps:{domain?:string;secret?:string;apiKey?:string;db:any;fetch?:typeof fetch;now?:number}):Promise<Response> {
  const response=(status=200)=>new Response(JSON.stringify(status===200?{ok:true}:{error:status===503?'inbound_not_configured':status===401?'invalid_webhook':'inbound_unavailable'}),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
  if(req.method!=='POST')return new Response(null,{status:405,headers:{Allow:'POST'}});
  const domain=validInboundDomain(deps.domain);if(!domain||!deps.secret||!deps.apiKey)return response(503);
  let raw:string;
  try{raw=await boundedText(req,65536);await verifyInboundWebhook(raw,req.headers,deps.secret,deps.now??Date.now());}catch{return response(401);}
  let event:any;try{event=JSON.parse(raw);}catch{return response(401);}
  if(event.type!=='email.received')return response();
  const id=event.data?.email_id;if(typeof id!=='string'||!UUID.test(id))return response();
  try {
    const upstream=await (deps.fetch??fetch)(`https://api.resend.com/emails/receiving/${encodeURIComponent(id)}?html_format=cid`,{headers:{Authorization:`Bearer ${deps.apiKey}`},signal:AbortSignal.timeout(15000)});
    if(!upstream.ok)return response(502);
    const email=JSON.parse(await boundedText(upstream,524288));
    const parsed=parseReceivedEmail(email,domain,id);
    const note=async(reason:string,review=true)=>await deps.db.rpc('bk_crm_note_email',{p_event_id:req.headers.get('svix-id'),p_email_id:id,p_route_token:parsed.routeToken,p_domain:domain,p_reason:reason,p_review:review});
    if(parsed.skip){
      if(parsed.skip==='provider_id_mismatch')return response(502);
      if(parsed.routeToken){const {error}=await note(parsed.skip,parsed.skip!=='automatic_message');if(error)return response(500);}
      return response();
    }
    const {data,error}=await deps.db.rpc('bk_crm_ingest_email',{p_event_id:req.headers.get('svix-id'),p_email_id:id,p_route_token:parsed.routeToken,p_domain:domain,p_from:parsed.from,p_body:parsed.body,p_message_id:parsed.messageId});
    if(error)return response(500);
    if(data?.status==='ignored'){const {error}=await note('sender_mismatch');if(error)return response(500);}
    return response();
  }catch{return response(502);}
}
