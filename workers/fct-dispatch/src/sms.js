/**
 * SMS hop for FCT dispatch.
 *
 * Twilio secrets live on this Worker (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN,
 * TWILIO_FROM). The phone app never holds those keys. Missing secrets return
 * a clear "SMS not configured" JSON and do not throw — assignment on the
 * device already succeeded.
 *
 * Never commit secret values. Tests must not hit Twilio.
 */

export function composeDriverSms(p){
  const po = String((p && p.po) || '').trim() || 'TBD';
  const origin = String((p && p.origin) || '').trim() || 'TBD';
  const dest = String((p && (p.dest || p.destination || p.dp)) || '').trim() || 'TBD';
  const appt = String((p && (p.appt || p.time)) || '').trim() || 'TBD';
  const driver = String((p && p.driver) || '').trim();
  const who = driver ? driver + ', ' : '';
  return 'FCT Dispatch: ' + who + 'PO ' + po + ', ' + origin + ' to ' + dest
    + ', appt ' + appt + '. Reply YES to take it. James';
}

export function smsConfigured(env){
  const e = env || {};
  return !!(String(e.TWILIO_ACCOUNT_SID || '').trim()
    && String(e.TWILIO_AUTH_TOKEN || '').trim()
    && String(e.TWILIO_FROM || '').trim());
}

function basicAuth(sid, token){
  const raw = String(sid) + ':' + String(token);
  if(typeof btoa === 'function') return btoa(raw);
  return Buffer.from(raw, 'utf8').toString('base64');
}

function readPayload(body){
  const b = body && typeof body === 'object' ? body : {};
  const load = (b.load && typeof b.load === 'object') ? b.load : {};
  return {
    to: String(b.to || '').trim(),
    driver: String(b.driver || b.driverName || '').trim(),
    origin: String(b.origin || load.origin || '').trim(),
    dest: String(b.dest || b.destination || b.dp || load.dest || load.destination || load.dp || '').trim(),
    appt: String(b.appt || b.time || load.appt || load.time || '').trim(),
    po: String(b.po || load.po || '').trim(),
    body: String(b.body || b.message || '').trim()
  };
}

export async function handleSendSms(request, env, opts){
  opts = opts || {};
  const fetchImpl = opts.fetch || globalThis.fetch;
  if(request.method !== 'POST'){
    return { status: 405, body: { ok:false, sent:false, error:'method_not_allowed' } };
  }
  if(!smsConfigured(env)){
    return { status: 200, body: { ok:false, sent:false, error:'SMS not configured' } };
  }
  let raw;
  try { raw = await request.json(); }
  catch(_){ return { status: 400, body: { ok:false, sent:false, error:'bad_json' } }; }

  const p = readPayload(raw);
  if(!p.to){
    return { status: 400, body: { ok:false, sent:false, error:'missing to' } };
  }
  const text = p.body || composeDriverSms(p);
  if(/\$\s*\d/.test(text) || /\$\d/.test(text)){
    return { status: 400, body: { ok:false, sent:false, error:'message must not include dollars' } };
  }

  const sid = String(env.TWILIO_ACCOUNT_SID).trim();
  const token = String(env.TWILIO_AUTH_TOKEN).trim();
  const from = String(env.TWILIO_FROM).trim();
  const twilioUrl = 'https://api.twilio.com/2010-04-01/Accounts/'
    + encodeURIComponent(sid) + '/Messages.json';

  let res;
  try {
    res = await fetchImpl(twilioUrl, {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + basicAuth(sid, token),
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({ To: p.to, From: from, Body: text }).toString()
    });
  } catch(e){
    return { status: 200, body: { ok:false, sent:false, error:'twilio_unreachable', detail:String(e && e.message || e) } };
  }

  let twilio = {};
  try { twilio = await res.json(); } catch(_){ twilio = {}; }
  if(!res.ok){
    return {
      status: 200,
      body: {
        ok:false, sent:false,
        error: String(twilio.message || twilio.error || ('twilio HTTP '+res.status)),
        code: twilio.code || res.status
      }
    };
  }
  return {
    status: 200,
    body: {
      ok:true, sent:true,
      sid: twilio.sid || null,
      to: p.to,
      driver: p.driver || null
    }
  };
}
