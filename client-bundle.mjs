import {readFile} from 'node:fs/promises';

const PLACEHOLDER='__GPUQ_PUBLIC_ORIGIN__';
export async function standaloneClient(origin=PLACEHOLDER){
  let source;
  try{source=await readFile(new URL('./build/gpuctl.mjs',import.meta.url),'utf8');}
  catch(error){if(error.code!=='ENOENT')throw error;throw Object.assign(Error('Standalone client is not built; run npm run build:client before starting the portal.'),{status:503});}
  const literal=JSON.stringify(PLACEHOLDER);
  if(!source.includes(literal))throw Error('Built client is missing its public origin placeholder');
  return source.replaceAll(literal,()=>JSON.stringify(origin));
}
