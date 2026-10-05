import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {request} from 'node:http';
import {directUploadConnectSources} from '../direct-upload-policy.mjs';
import {createPortalServer} from '../portal-server.mjs';
test('CSP permits only operator-configured exact HTTPS origins',()=>{
 assert.equal(directUploadConnectSources(), '');
 assert.equal(directUploadConnectSources('["https://upload.example:18441","https://upload.example:18441"]'),'https://upload.example:18441');
 for(const value of ['https://*.example','http://upload.example','https://user:pass@upload.example','https://upload.example/path','https://upload.example/?key=secret','https://upload.example;script-src','https://upload.example/#x','https://upload.example/'])assert.throws(()=>directUploadConnectSources([value]));
 assert.throws(()=>directUploadConnectSources('not json'));
});
test('actual portal response includes upload origins without widening scripts, media or auth origin',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'gpuq-upload-policy-'));let server;
 try{
  const bootstrap=join(dir,'bootstrap.json');await writeFile(bootstrap,JSON.stringify({username:'admin',password:'Only-A-Test-Password-2026!'}));
  ({server}=await createPortalServer({database:join(dir,'db'),bootstrap,origin:'https://portal.example',directUploadOrigins:['https://upload.example:18441','https://upload.example:18442','https://tail-upload.example:18441']}));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const requestHost=(path,options={})=>new Promise((resolve,reject)=>{const req=request(`http://127.0.0.1:${server.address().port}${path}`,{...options,headers:{Host:'portal.example',...options.headers}},res=>{res.resume();res.on('end',()=>resolve({status:res.statusCode,headers:new Headers(res.headers)}));});req.on('error',reject);req.end(options.body);});
  const response=await requestHost('/');
  assert.equal(response.status,200);const csp=response.headers.get('content-security-policy');
  assert.match(csp,/connect-src 'self' https:\/\/upload.example:18441 https:\/\/upload.example:18442 https:\/\/tail-upload.example:18441;/);
  assert.ok(!csp.includes('https://tail-upload.example:18442'));
  assert.equal((await requestHost('/upload-routes.js')).status,200);
  assert.match(csp,/script-src 'self';/);assert.ok(!csp.includes('*'));
  const foreign=await requestHost('/api/call',{method:'POST',headers:{Origin:'https://upload.example:18441','Content-Type':'application/json'},body:'{"operation":"state"}'});
  assert.equal(foreign.status,403);
 }finally{if(server)await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true});}
});
