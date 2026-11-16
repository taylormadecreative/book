import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
let failed = false;
for (const file of readdirSync('tests').filter(f=>f.endsWith('.e2e.mjs')).sort()) {
  const r=spawnSync(process.execPath,[`tests/${file}`],{stdio:'inherit'});
  if (r.error || r.signal || r.status !== 0) {
    failed = true;
    console.error(`${file} failed (${r.error?.message ?? r.signal ?? r.status})`);
  }
}
process.exitCode = failed ? 1 : 0;
