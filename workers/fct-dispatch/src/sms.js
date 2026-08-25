/* SMS provider hook.
 * Optional. Twilio is the default if TWILIO_* secrets exist later;
 * Sinch / Telnyx swap via SMS_PROVIDER. Not required (Hotmail, no
 * company email). Missing secrets → { ok:false, error:'SMS not configured' }.
 * Never throw for that case; the assignment on the phone must still succeed. */

export const SMS_NOT_CONFIGURED = 'SMS not configured';

export function twilioReady(env){
  return !!(env && String(env.TWILIO_ACCOUNT_SID||'').trim()
    && String(env.TWILIO_AUTH_TOKEN||'').trim()
    && String(env.TWILIO_FROM||'').trim());
}
export function sinchReady(env){
  return !!(env && String(env.SINCH_SERVICE_PLAN_ID||'').trim()
    && String(env.SINCH_API_TOKEN||'').trim()
    && String(env.SINCH_FROM||'').trim());
}
export function telnyxReady(env){
  return !!(env && String(env.TELNYX_API_KEY||'').trim()
    && String(env.TELNYX_FROM||'').trim());
}

/* Which sender to use. Unset SMS_PROVIDER → Twilio if its vars are present. */
export function resolveSmsProvider(env){
  const requested = String((env && env.SMS_PROVIDER) || 'twilio').toLowerCase().trim();
  if(requested === 'sinch') return sinchReady(env) ? 'sinch' : null;
  if(requested === 'telnyx') return telnyxReady(env) ? 'telnyx' : null;
  if(requested === 'twilio' || requested === '') return twilioReady(env) ? 'twilio' : null;
  return null;
}

export function composeDriverSms(body){
  const origin = String((body && body.origin) || '').trim() || 'TBD';
  const dest = String((body && (body.dest || body.dp || body.deliveryPoint)) || '').trim() || 'TBD';
  const appt = String((body && (body.appt || body.time)) || '').trim() || 'TBD';
  const po = String((body && body.po) || '').trim() || 'TBD';
  return 'FCT: '+origin+' → '+dest+', '+appt+', PO '+po+'. Reply YES to take it. — James';
}

async function sendTwilio(env, { to, text }, fetchImpl){
  const sid = String(env.TWILIO_ACCOUNT_SID).trim();
  const token = String(env.TWILIO_AUTH_TOKEN).trim();
  const from = String(env.TWILIO_FROM).trim();
  const url = 'https://api.twilio.com/2010-04-01/Accounts/'+encodeURIComponent(sid)+'/Messages.json';
  const auth = btoa(sid+':'+token);
  const r = await fetchImpl(url, {
    method: 'POST',
    headers: {
      Authorization: 'Basic '+auth,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({ To: to, From: from, Body: text }).toString()
  });
  const raw = await r.text();
  let parsed = null;
  try { parsed = JSON.parse(raw); } catch(_){}
  if(!r.ok){
    const msg = (parsed && (parsed.message || parsed.error_message)) || ('Twilio HTTP '+r.status);
    return { ok:false, provider:'twilio', error: String(msg).slice(0,180) };
  }
  return { ok:true, provider:'twilio', sid: parsed && parsed.sid ? parsed.sid : '' };
}

/* Stubs — same return shape. Fill in when FCT swaps vendors. */
async function sendSinch(){ return { ok:false, provider:'sinch', error: SMS_NOT_CONFIGURED }; }
async function sendTelnyx(){ return { ok:false, provider:'telnyx', error: SMS_NOT_CONFIGURED }; }

export const SMS_PROVIDERS = {
  twilio: { send: sendTwilio },
  sinch:  { send: sendSinch },
  telnyx: { send: sendTelnyx }
};

export async function sendSms(env, payload, fetchImpl){
  const to = String((payload && payload.to) || '').trim();
  if(!to) return { ok:false, error:'missing to' };
  const provider = resolveSmsProvider(env);
  if(!provider) return { ok:false, configured:false, error: SMS_NOT_CONFIGURED };
  const text = String((payload && payload.body) || '').trim() || composeDriverSms(payload);
  const impl = fetchImpl || fetch;
  try {
    return await SMS_PROVIDERS[provider].send(env, { to, text }, impl);
  } catch(e){
    return { ok:false, provider, error: String(e && e.message || e).slice(0,180) };
  }
}
