import test from 'node:test';
import assert from 'node:assert/strict';
import {guardedRoute} from './browser-route-guard.mjs';

test('route teardown only tolerates the three documented cancellation errors',async()=>{
  for(const message of ['route.continue: Route is already handled!','route.abort: Target page, context or browser has been closed','route.fulfill: Target closed']){
    await guardedRoute(async route=>{await route.continue();})({continue:async()=>{throw Error(message);}});
  }
  for(const error of [Error('route.continue: net::ERR_CONNECTION_RESET'),Error('Timeout 30000ms exceeded'),new assert.AssertionError({message:'external requests must remain empty'})]){
    await assert.rejects(guardedRoute(async route=>{await route.continue();})({continue:async()=>{throw error;}}),value=>value===error);
  }
});

test('a route handler remains pending until its awaited operation settles',async()=>{
  let resolve,finished=false;
  const operation=new Promise(done=>{resolve=done;});
  const pending=guardedRoute(async route=>{await route.fallback();finished=true;})({fallback:()=>operation});
  await Promise.resolve();assert.equal(finished,false);
  resolve();await pending;assert.equal(finished,true);
});
