import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';

// Compile the actual import graph. Shared CLI modules need no special export
// registry, runtime compiler, text inlining, or hand-maintained dependency list.
export async function buildClient({root=fileURLToPath(new URL('..',import.meta.url)),outfile=resolve(root,'build/gpuctl.mjs')}={}){
  return build({absWorkingDir:root,entryPoints:['cli.mjs'],outfile,bundle:true,
    platform:'node',format:'esm',target:'node22.13',charset:'utf8',sourcemap:false,
    legalComments:'inline',metafile:true,logLevel:'silent'});
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  await buildClient();process.stdout.write('Built standalone client: build/gpuctl.mjs\n');
}
