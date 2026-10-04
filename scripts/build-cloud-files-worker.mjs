import {build} from 'esbuild';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {dirname,join} from 'node:path';

const root=dirname(dirname(fileURLToPath(import.meta.url))),folder=join(root,'build');
await mkdir(folder,{recursive:true});
const target=join(folder,'cloud-files-worker.mjs');
await build({entryPoints:[join(root,'cloud-files-worker.mjs')],outfile:target,bundle:true,
  platform:'node',target:'node24',format:'esm',legalComments:'eof',
  banner:{js:"import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);"}});
const raw=await readFile(target),sha256=createHash('sha256').update(raw).digest('hex');
await writeFile(join(folder,'cloud-files-worker.json'),JSON.stringify({schema:1,nodeMajor:24,
  artifact:'cloud-files-worker.mjs',bytes:raw.length,sha256})+'\n');
console.log(JSON.stringify({artifact:target,sha256,bytes:raw.length,nodeMajor:24}));
