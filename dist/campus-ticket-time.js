// Node authority keeps the original signed expiry. This only bounds client
// clock differences; accepting a timestamp never extends the server ticket.
export const CAMPUS_TICKET_TTL_SECONDS=300,CAMPUS_CLOCK_SKEW_SECONDS=120;
export function validCampusTicketTime(value,now=Date.now()/1000){
  if(!Number.isFinite(now)||!Number.isSafeInteger(value?.expiresAt)||value.expiresAt<=0
    ||value.expiresAt<=now-CAMPUS_CLOCK_SKEW_SECONDS)return false;
  if(value.issuedAt===undefined&&value.ttl===undefined)
    return value.expiresAt<=now+CAMPUS_TICKET_TTL_SECONDS+CAMPUS_CLOCK_SKEW_SECONDS;
  // When authority supplies issuance metadata, its exact lifetime takes
  // precedence. Partial, inconsistent or excessive metadata is not a fallback.
  return Number.isSafeInteger(value.issuedAt)&&value.issuedAt>=0
    &&Number.isSafeInteger(value.ttl)&&value.ttl>0&&value.ttl<=CAMPUS_TICKET_TTL_SECONDS
    &&value.expiresAt===value.issuedAt+value.ttl
    &&value.issuedAt<=now+CAMPUS_CLOCK_SKEW_SECONDS;
}
