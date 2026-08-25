import { strict as assert } from 'node:assert';
import { composeDriverSms, smsConfigured, handleSendSms } from './sms.js';

{
  const msg = composeDriverSms({
    driver: 'Greg', origin: 'PNG', dest: 'LATHROP', appt: '6am', po: '75811-49'
  });
  assert.match(msg, /PNG/);
  assert.match(msg, /LATHROP/);
  assert.match(msg, /6am/);
  assert.match(msg, /75811-49/);
  assert.doesNotMatch(msg, /\$/);
  assert.match(msg, /YES/);
}

{
  assert.equal(smsConfigured({}), false);
  assert.equal(smsConfigured({ TWILIO_ACCOUNT_SID:'ACxx' }), false);
  assert.equal(smsConfigured({
    TWILIO_ACCOUNT_SID:'ACxx', TWILIO_AUTH_TOKEN:'tok', TWILIO_FROM:'+15551212'
  }), true);
}

function req(body, method){
  return {
    method: method || 'POST',
    async json(){ return body; }
  };
}

{
  const r = await handleSendSms(req({ to:'+15550001111', po:'1' }, 'GET'), {
    TWILIO_ACCOUNT_SID:'AC', TWILIO_AUTH_TOKEN:'tok', TWILIO_FROM:'+1'
  });
  assert.equal(r.status, 405);
}

{
  const r = await handleSendSms(req({ to:'+15550001111', driver:'Greg', origin:'PNG', dest:'RIPON', appt:'9am', po:'12' }), {});
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, false);
  assert.equal(r.body.sent, false);
  assert.equal(r.body.error, 'SMS not configured');
}

{
  const r = await handleSendSms(req({ driver:'Greg' }), {
    TWILIO_ACCOUNT_SID:'AC', TWILIO_AUTH_TOKEN:'tok', TWILIO_FROM:'+15551212'
  });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'missing to');
}

{
  let called = 0;
  const fakeFetch = async (url, init) => {
    called++;
    assert.match(url, /api\.twilio\.com/);
    assert.equal(init.method, 'POST');
    const params = new URLSearchParams(init.body);
    assert.equal(params.get('To'), '+15550001111');
    assert.equal(params.get('From'), '+15551212');
    assert.doesNotMatch(params.get('Body'), /\$/);
    assert.match(params.get('Body'), /PNG/);
    return { ok:true, status:201, json: async () => ({ sid:'SM123' }) };
  };
  const r = await handleSendSms(
    req({ to:'+15550001111', driver:'Greg', origin:'PNG', dest:'LATHROP', appt:'6am', po:'75811-49' }),
    { TWILIO_ACCOUNT_SID:'ACxx', TWILIO_AUTH_TOKEN:'tok', TWILIO_FROM:'+15551212' },
    { fetch: fakeFetch }
  );
  assert.equal(called, 1);
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.sent, true);
  assert.equal(r.body.sid, 'SM123');
}

{
  const r = await handleSendSms(
    req({ to:'+1', body:'Pay is $500 for this load' }),
    { TWILIO_ACCOUNT_SID:'AC', TWILIO_AUTH_TOKEN:'tok', TWILIO_FROM:'+1' },
    { fetch: async () => { throw new Error('must not call Twilio'); } }
  );
  assert.equal(r.status, 400);
  assert.match(r.body.error, /dollars/i);
}

console.log('fct-dispatch sms tests ok');
