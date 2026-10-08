// Explicit subprocess-only test seam. Production extraction, framing and CLI
// journals remain real; only the physical-kernel/TLS-PKI leg is substituted by
// a pinned loopback HTTPS fixture. The native Go suite owns those OS contracts.
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {fileURLToPath} from 'node:url';
import {basename,dirname} from 'node:path';

const spawn=childProcess.spawn;
const helper=fileURLToPath(new URL('./campus-native-fixture-helper.mjs',import.meta.url));
childProcess.spawn=function(program,args,options){
  if(typeof program==='string'&&basename(program)==='campus-http'&&basename(dirname(program)).startsWith('stargate-campus-')){
    if(args.length!==0||Object.keys(options.env||{}).length!==0)throw Error('Native fixture must retain empty argv/environment');
    return spawn(process.execPath,[helper],options);
  }
  return spawn(program,args,options);
};
syncBuiltinESMExports();
