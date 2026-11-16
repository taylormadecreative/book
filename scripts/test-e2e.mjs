import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
for (const file of readdirSync('tests').filter(f=>f.endsWith('.e2e.mjs')).sort()) {
  const r=spawnSync(process.execPath,[`tests/${file}`],{stdio:'inherit'});
  if(r.status) process.exit(r.status);
}
