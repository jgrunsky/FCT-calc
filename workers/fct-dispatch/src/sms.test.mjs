import { strict as assert } from 'node:assert';
import { sendSms, resolveSmsProvider, composeDriverSms, SMS_NOT_CONFIGURED, twilioReady } from './sms.js';

{
  assert.equal(resolveSmsProvider({}), null);
  assert.equal(resolveSmsProvider({ TWILIO_ACCOUNT_SID:'ACxx' }), null);
  assert.equal(twilioReady({
    TWILIO_ACCOUNT_SID:'ACxx', TWILIO_AUTH_TOKEN:'tok', TWILIO_FROM:'+15551212'
  }), true);
  assert.equal(resolveSmsProvider({
    TWILIO_ACCOUNT_SID:'ACxx', TWILIO_AUTH_TOKEN:'tok', TWILIO_FROM:'+15551212'
  }), 'twilio');
  assert.equal(resolveSmsProvider({
    SMS_PROVIDER:'sinch',
    TWILIO_ACCOUNT_SID:'ACxx', TWILIO_AUTH_TOKEN:'tok', TWILIO_FROM:'+15551212'
  }), null, 'sinch requested but not configured must not fall through to Twilio');
  assert.equal(resolveSmsProvider({
    SMS_PROVIDER:'telnyx', TELNYX_API_KEY:'k', TELNYX_FROM:'+1'
  }), 'telnyx');
}

{
  const msg = composeDriverSms({ origin:'PNG', dest:'LATHROP', appt:'6am', po:'76495-42' });
  assert.match(msg, /PNG/);
  assert.match(msg, /LATHROP/);
  assert.match(msg, /6am/);
  assert.match(msg, /76495-42/);
  assert.doesNotMatch(msg, /\$/);
  assert.doesNotMatch(msg, /revenue/i);
  assert.doesNotMatch(msg, /\d+\.\d{2}/);
}

{
  let called = false;
  const r = await sendSms({}, { to:'+1555', origin:'PNG', dest:'RIPON', appt:'7am', po:'1' }, ()=>{
    called = true;
    throw new Error('Twilio must not be called when secrets are missing');
  });
  assert.equal(called, false);
  assert.equal(r.ok, false);
  assert.equal(r.configured, false);
  assert.equal(r.error, SMS_NOT_CONFIGURED);
}

{
  let called = false;
  const r = await sendSms(
    { SMS_PROVIDER:'twilio' },
    { to:'+1555', origin:'PNG', dest:'RIPON', appt:'7am', po:'1' },
    ()=>{ called = true; return { ok:true, text: async ()=> '{}' }; }
  );
  assert.equal(called, false);
  assert.equal(r.error, SMS_NOT_CONFIGURED);
}

{
  const calls = [];
  const env = { TWILIO_ACCOUNT_SID:'ACxx', TWILIO_AUTH_TOKEN:'tok', TWILIO_FROM:'+15550000' };
  const r = await sendSms(env, { to:'+15551111', origin:'PNG', dest:'LATHROP', appt:'6am', po:'9' }, async (url, opts)=>{
    calls.push({ url, opts });
    return { ok:true, text: async ()=> JSON.stringify({ sid:'SM123', status:'queued' }) };
  });
  assert.equal(r.ok, true);
  assert.equal(r.provider, 'twilio');
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /api\.twilio\.com/);
  assert.match(calls[0].opts.body, /To=%2B15551111/);
  assert.doesNotMatch(calls[0].opts.body, /\$/);
}

{
  const r = await sendSms({ SMS_PROVIDER:'sinch' }, { to:'+1' }, ()=>{ throw new Error('no'); });
  assert.equal(r.ok, false);
  assert.equal(r.error, SMS_NOT_CONFIGURED);
}

console.log('sms.test.mjs ok');
