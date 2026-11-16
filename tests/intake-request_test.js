import { assertEquals, assertNotEquals, assert } from 'jsr:@std/assert@1';
import { submissionFor, completeSubmission } from '../js/intake-request.js';
Deno.test('submission capability survives retries; changed forms and lanes remain separate',async()=>{
  const data=new Map(); const storage={getItem:k=>data.get(k)||null,setItem:(k,v)=>data.set(k,v)};
  const form={p_name:'Sample Person',p_email:'sample@example.test'};
  const first=await submissionFor('inquiry',form,storage);
  assertEquals(await submissionFor('inquiry',form,storage),first);
  assertNotEquals(await submissionFor('inquiry',{...form,p_name:'Changed'},storage),first);
  assertNotEquals(await submissionFor('digitals',form,storage),first);
  assert(![...data.values()].join('').includes('sample@example.test'));
});
Deno.test('confirmed success starts a new capability for a later identical job',async()=>{
  const data=new Map(); const storage={getItem:k=>data.get(k)||null,setItem:(k,v)=>data.set(k,v),removeItem:k=>data.delete(k)};
  const form={p_name:'Repeat Customer',p_email:'repeat@example.test'};
  const first=await submissionFor('repeat',form,storage);
  completeSubmission('repeat',storage);
  assertNotEquals(await submissionFor('repeat',form,storage),first);
});
Deno.test('storage refusal still protects same-tab retries',async()=>{
  const storage={getItem(){throw Error('disabled');},setItem(){throw Error('disabled');}};
  const form={p_name:'Sample',p_email:'private@example.test'};
  assertEquals(await submissionFor('private',form,storage),await submissionFor('private',form,storage));
});
Deno.test('a throwing sessionStorage property does not break public intake',async()=>{
  const descriptor=Object.getOwnPropertyDescriptor(globalThis,'sessionStorage');
  Object.defineProperty(globalThis,'sessionStorage',{configurable:true,get(){throw Error('SecurityError');}});
  try {
    const form={p_name:'Sample Private',p_email:'private@example.test'};
    assertEquals(await submissionFor('blocked-getter',form),await submissionFor('blocked-getter',form));
  } finally { if(descriptor)Object.defineProperty(globalThis,'sessionStorage',descriptor);else delete globalThis.sessionStorage; }
});
