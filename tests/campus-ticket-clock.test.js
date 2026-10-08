import test from 'node:test';
import assert from 'node:assert/strict';
import {validCampusTicketTime} from '../dist/campus-ticket-time.js';
import {validateDirectGrant} from '../client-direct-upload.mjs';
import {validateBrowserUploadGrant} from '../dist/dataset-upload.js';

const server=1700000000,ttl=300,chunk=1048576;
const grant=()=>({available:true,protocol:'dataset-upload-v1',kind:'campus-direct',routeId:'primary',
  endpoint:'https://campus.example',certificateSha256:'a'.repeat(64),revision:'b'.repeat(64),
  expiresAt:server+ttl,chunkBytes:chunk,ticket:'isolated-capability-123456789'});
for(const [name,check] of [['CLI',validateDirectGrant],['browser',validateBrowserUploadGrant]]){
  test(name+' dataset ticket accepts bounded clock skew with unchanged authority checks',()=>{
    for(const skew of [-5,5,-119])for(const metadata of [false,true]){
      const value={...grant(),...(metadata?{issuedAt:server,ttl}:{})};
      assert.equal(check(value,server+skew).expiresAt,server+ttl);
    }
    assert.equal(check({...grant(),expiresAt:server-119},server).expiresAt,server-119);
    assert.throws(()=>check({...grant(),expiresAt:server-120},server));
    assert.equal(check({...grant(),expiresAt:server+420},server).expiresAt,server+420);
    assert.throws(()=>check({...grant(),expiresAt:server+421},server));
    for(const change of [{protocol:'other'},{certificateSha256:'invalid'},{chunkBytes:2*chunk},{ticket:'invalid'},{endpoint:'http://campus.example'}])
      assert.throws(()=>check({...grant(),...change},server-5));
  });
}
test('issuance metadata takes precedence; partial or inconsistent TTL cannot use the fallback',()=>{
  assert.equal(validCampusTicketTime({issuedAt:server,ttl:30,expiresAt:server+30},server-119),true);
  for(const change of [{ttl:301},{ttl:0},{ttl:1.5},{issuedAt:server+121,expiresAt:server+151},
    {expiresAt:server+31},{issuedAt:undefined},{ttl:undefined},{issuedAt:NaN}])
    assert.equal(validCampusTicketTime({issuedAt:server,ttl:30,expiresAt:server+30,...change},server),false);
});
