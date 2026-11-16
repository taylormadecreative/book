import { mkdirSync, readdirSync, cpSync, rmSync } from 'node:fs';
const destination='.site-build';
rmSync(destination,{recursive:true,force:true}); mkdirSync(destination);
for(const entry of readdirSync('.',{withFileTypes:true})) {
  if((entry.isFile() && (/\.html$/.test(entry.name) || ['CNAME','.nojekyll'].includes(entry.name))) ||
    (entry.isDirectory() && ['assets','css','js','inbox','crm'].includes(entry.name))) {
    cpSync(entry.name,`${destination}/${entry.name}`,{recursive:true});
  }
}
console.log(`Prepared static CRM at ${destination}`);
