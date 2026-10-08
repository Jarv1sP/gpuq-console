import {spawn} from 'node:child_process';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {campusGoToolchain,CAMPUS_GO_VERSION} from './campus-go-toolchain.mjs';

const root=fileURLToPath(new URL('..',import.meta.url));
const run=(program,args,options)=>new Promise((yes,no)=>{const child=spawn(program,args,{stdio:'inherit',...options});child.on('error',no);child.on('exit',code=>code===0?yes():no(Error('Native compile failed')));});
export function campusNativeBuildDefine(manifest){
  if(manifest?.schema!==1||manifest.protocol!=='campus-native-https-v1')throw Error('Invalid native artifact manifest');
  return {STARGATE_CAMPUS_NATIVE_BUNDLE:JSON.stringify(manifest)};
}
export async function buildCampusNative({go=process.env.GO,root:buildRoot=root,outdir=resolve(buildRoot,'build/campus-native')}={}){
  go=await campusGoToolchain({go,root:buildRoot});
  await mkdir(outdir,{recursive:true,mode:0o700});const manifest={schema:1,protocol:'campus-native-https-v1',goVersion:CAMPUS_GO_VERSION,artifacts:{}};
  for(const [arch,goarch] of [['x64','amd64'],['arm64','arm64']]){
    const outfile=resolve(outdir,`campus-http-linux-${arch}`);
    await run(go,['build','-trimpath','-buildvcs=false','-ldflags=-s -w -buildid=','-o',outfile,'.'],{cwd:resolve(buildRoot,'native/campus-http'),env:{...process.env,GOOS:'linux',GOARCH:goarch,CGO_ENABLED:'0',GOTOOLCHAIN:'local'}});
    const bytes=await readFile(outfile);manifest.artifacts[`linux-${arch}`]={sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length,base64:bytes.toString('base64')};
  }
  await writeFile(resolve(outdir,'embedded-artifacts.private.json'),JSON.stringify(manifest)+'\n',{mode:0o600});return manifest;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  await buildCampusNative();process.stdout.write('Built verified Linux native artifacts for the standalone client.\n');
}
