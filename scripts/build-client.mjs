import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {access} from 'node:fs/promises';
import {buildCampusNative,campusNativeBuildDefine} from './build-campus-native.mjs';

// Compile the actual import graph. Shared CLI modules need no special export
// registry, runtime compiler, text inlining, or hand-maintained dependency list.
export async function buildClient({root=fileURLToPath(new URL('..',import.meta.url)),outfile=resolve(root,'build/gpuctl.mjs'),go=process.env.GO,nativeBuilder=buildCampusNative}={}){
  // Tiny bundler fixtures have no native source graph. Real repository builds
  // always compile and embed both Linux architectures; no runtime dependency.
  let native=false;try{await access(resolve(root,'native/campus-http/go.mod'));native=true;}catch(e){if(e.code!=='ENOENT')throw e;}
  const define=native?campusNativeBuildDefine(await nativeBuilder({root,go})):{};
  return build({absWorkingDir:root,entryPoints:['cli.mjs'],outfile,bundle:true,
    define,
    platform:'node',format:'esm',target:'node22.13',charset:'utf8',sourcemap:false,
    legalComments:'inline',metafile:true,logLevel:'silent'});
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  await buildClient();process.stdout.write('Built standalone client: build/gpuctl.mjs\n');
}
