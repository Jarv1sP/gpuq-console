import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {LoginSessions,LOGIN_POLICY} from '../login-sessions.mjs';
const hash=token=>createHash('sha256').update(token).digest('hex');
const principal={userId:'demo-user-1',username:'alice',role:'member'};
function fixture(t){
  const db=new DatabaseSync(':memory:'),user={id:principal.userId,username:'alice',role:'member',enabled:true};
  let time=100000000;const sessions=new LoginSessions(db,id=>id===user.id?user:undefined,{now:()=>time});
  t.after(()=>db.close());return {db,user,sessions,advance:ms=>time+=ms,time:()=>time};
}
test('SQLite stores only random token hashes; neither hashes nor malformed credentials authenticate',t=>{
  const f=fixture(t),token=f.sessions.issue(principal),other=f.sessions.issue(principal);
  assert.match(token,/^[a-f0-9]{64}$/);assert.notEqual(token,other);
  const rows=f.db.prepare('SELECT * FROM login_sessions').all();assert.equal(JSON.stringify(rows).includes(token),false);assert.equal(rows[0].token_hash,hash(token));
  assert.equal(f.sessions.principal(token).userId,principal.userId);
  for(const invalid of [hash(token),'invalid',null,'../file'])assert.throws(()=>f.sessions.principal(invalid),e=>e.status===401);
});
test('eight hours no longer expires active credentials; writes are hourly, and idle expiry cannot renew',t=>{
  const f=fixture(t),token=f.sessions.issue(principal),initial=f.db.prepare('SELECT * FROM login_sessions').get();
  f.advance(1000);f.sessions.principal(token);assert.deepEqual(f.db.prepare('SELECT * FROM login_sessions').get(),initial);
  f.advance(9*3600_000);assert.equal(f.sessions.principal(token).expires,f.time()+LOGIN_POLICY.idleMs);
  f.advance(LOGIN_POLICY.idleMs);assert.throws(()=>f.sessions.principal(token),e=>e.status===401);assert.equal(f.db.prepare('SELECT count(*) n FROM login_sessions').get().n,0);
});
test('daily use keeps a session alive across four months without replacing its credential',t=>{
  const f=fixture(t),token=f.sessions.issue(principal);
  for(let day=0;day<120;day++){f.advance(86400_000);assert.equal(f.sessions.principal(token).username,'alice');}
  assert.equal(f.db.prepare('SELECT count(*) n FROM login_sessions').get().n,1);
});
test('disabled, demoted, deleted or renamed identity fails closed and never revives',t=>{
  for(const change of [u=>u.enabled=false,u=>u.role='admin',u=>u.username='other',u=>u.id='deleted']){
    const f=fixture(t),token=f.sessions.issue(principal);change(f.user);
    assert.throws(()=>f.sessions.principal(token),e=>e.status===403);
    Object.assign(f.user,{id:principal.userId,username:'alice',role:'member',enabled:true});
    assert.throws(()=>f.sessions.principal(token),e=>e.status===401);
  }
});
test('device logout is selective, account invalidation is complete, and login prunes expired rows',t=>{
  const f=fixture(t),first=f.sessions.issue(principal),second=f.sessions.issue(principal);
  f.sessions.revoke(first);assert.throws(()=>f.sessions.principal(first),e=>e.status===401);assert.equal(f.sessions.principal(second).userId,principal.userId);
  f.sessions.invalidate('alice');assert.throws(()=>f.sessions.principal(second),e=>e.status===401);
  f.sessions.issue(principal);f.advance(LOGIN_POLICY.idleMs+1);f.sessions.issue(principal);assert.equal(f.db.prepare('SELECT count(*) n FROM login_sessions').get().n,1);
});
test('provider replacement restores valid credentials; failed persistence never reports successful login',t=>{
  const f=fixture(t),token=f.sessions.issue(principal),replacement=new LoginSessions(f.db,id=>id===f.user.id?f.user:undefined,{now:f.time});
  assert.equal(replacement.principal(token).userId,principal.userId);
  f.db.exec("CREATE TRIGGER fail_session BEFORE INSERT ON login_sessions BEGIN SELECT RAISE(ABORT,'session disk failure'); END;");
  assert.throws(()=>replacement.issue(principal),/session disk failure/);assert.equal(f.db.prepare('SELECT count(*) n FROM login_sessions').get().n,1);
});
