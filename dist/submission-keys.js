// A lost reply retains the original payload and key until a definite result.
export function createSubmissionKeys(){
  const pending=new Map();
  return {
    request(channel,payload){const signature=JSON.stringify(payload),previous=pending.get(channel);if(previous?.uncertain&&previous.signature!==signature)throw Error('上次发送结果尚未确认。请先重试原内容，避免重复发送。');const record=previous?.signature===signature?previous:{key:crypto.randomUUID(),signature,uncertain:false};pending.set(channel,record);return {...payload,key:record.key};},
    uncertain(channel){const record=pending.get(channel);if(record)record.uncertain=true;},
    confirmed(channel){pending.delete(channel);},
    hasUncertain(channel){return pending.get(channel)?.uncertain===true;},
    reset(){pending.clear();}
  };
}
