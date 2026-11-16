import { readdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const walk = dir => readdirSync(dir, {withFileTypes:true}).flatMap(e => e.isDirectory() ? walk(`${dir}/${e.name}`) : [`${dir}/${e.name}`]);
const files = [...walk('js'), ...walk('scripts'), ...walk('tests')].filter(f => /\.(m?js)$/.test(f));
for (const file of files) {
  const r = spawnSync(process.execPath, ['--check', file], {stdio:'inherit'});
  if (r.status) process.exit(r.status);
}
for (const file of walk('tests').filter(f => /\.(m?js)$/.test(f))) {
  if (/from ["']\/Users\//.test(readFileSync(file,'utf8'))) throw Error(`Machine-specific test import: ${file}`);
}
console.log(`Syntax and portable imports: ${files.length} files passed`);
