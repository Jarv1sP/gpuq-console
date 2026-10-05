// Await the handler so teardown errors cannot escape as unhandled promises.
// Keep transport errors, fixture failures and assertions visible to the test.
export function guardedRoute(handler){
  return async route=>{
    try{await handler(route);}
    catch(error){if(!/already handled|has been closed|Target closed/.test(error?.message||''))throw error;}
  };
}
