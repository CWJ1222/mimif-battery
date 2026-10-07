// menu.mjs — SwiftBar display controller for the MiFi battery.
//
// Shows the value only while connected to the *paired* modem: Wi-Fi's router is
// HOST, the route to it is over Wi-Fi (even if wired LAN holds the default route),
// AND its gateway MAC equals the one pinned by `--pair` (identity.mjs). Another
// router that also uses 192.168.0.1 -> hidden. Unpaired -> hidden. Caches the last
// reading, logs in at most every 5 minutes, serializes all state changes and all
// logins across processes, backs off on failure, never auto-retries a wrong
// password, and offers Refresh / Pause / Resume.
//
// Invocations:
//   node menu.mjs             render for SwiftBar (default; may log in)
//   node menu.mjs --refresh   queue a one-shot forced attempt, then render
//   node menu.mjs --pause 30  pause auto-login for N minutes, then render
//   node menu.mjs --resume    clear the pause, then render
//   node menu.mjs --reset-auth clear a wrong-password block + queue a retry (setup.sh)
//   node menu.mjs --pair [MAC] on the modem's Wi-Fi: log in once, pin its gateway MAC
//   node menu.mjs --unpair    forget the pinned modem (the item hides everywhere)
//   node menu.mjs --pair-status  print the pinned MAC; exit 1 if unpaired

import { readBattery, ProbeError } from './probe.mjs';
import { LOGIN_LOCK, readState, updateState, withLock } from './coordination.mjs';
import { observeGateway, pairedMac, isModem, normMac } from './identity.mjs';
import { fileURLToPath } from 'node:url';

const HOST = process.env.MODEM_HOST || '192.168.0.1';
const LOGIN_TTL = 5 * 60 * 1000; // minimum time between login *attempts* (floor)
const STALE_MS = 5 * 60 * 1000;  // mark the value stale in the bar after this
const DROP_MS = 15 * 60 * 1000;  // drop the number entirely after this
const BACKOFF_MIN = [5, 10, 20, 30]; // minutes, by consecutive hard-failure count

const NODE = process.execPath;
const SELF = fileURLToPath(import.meta.url);

// ---------- network gate (identity.mjs: router + Wi-Fi route + pinned MAC) ----------
// On target iff the gateway is the paired modem. Which interface holds the default
// route does not matter, so a wired LAN ranked above Wi-Fi does not hide us. If we
// cannot confirm (unpaired, no ARP entry, other MAC), we hide.
async function onTargetNetwork(state) {
  return isModem(await observeGateway(HOST), HOST, pairedMac(state, HOST));
}
const IDENTITY_CODES = new Set(['not-paired', 'not-modem']); // not a modem failure: no backoff

// ---------- SwiftBar rendering ----------
function fmtAge(ms) {
  const m = Math.round(ms / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60 ? ` ${m % 60}m` : ''} ago`;
}
const q = (s) => `"${String(s).replace(/(["\\])/g, '\\$1')}"`; // quote for the SwiftBar param parser (escape, don't strip)
function action(title, extra) {
  return `${title} | refresh=true terminal=false bash=${q(NODE)} param1=${q(SELF)}${extra}`;
}

function render(state, { offline = false } = {}) {
  if (offline) {
    process.stdout.write('\n'); // empty -> SwiftBar hides the item
    return;
  }
  const now = Date.now();
  const has = typeof state.percent === 'number';
  const age = has && state.ts ? now - state.ts : Infinity;
  const paused = state.pauseUntil && now < state.pauseUntil;
  const icon = state.charging ? '🔌' : '🔋';
  const lines = [];

  if (!has || age > DROP_MS) lines.push('🔋 —');
  else {
    const stale = age > STALE_MS ? ' ·' : '';
    const color = state.percent <= 20 && !state.charging ? ' | color=#c0392b' : '';
    lines.push(`${icon} ${state.percent}%${stale}${color}`);
  }
  lines.push('---');
  lines.push(`${state.model || 'MiFi'} battery`);
  if (has) {
    lines.push(`Charge: ${state.percent}%${state.charging ? ' (charging)' : ''}`);
    if (state.signal != null) lines.push(`Signal: ${state.signal}/5`);
    lines.push(`Updated: ${state.ts ? fmtAge(now - state.ts) : 'unknown'}`);
  } else {
    lines.push('No reading yet');
  }
  if (paused) lines.push(`Auto-refresh paused until ${new Date(state.pauseUntil).toLocaleTimeString()}`);
  if (state.lastCode === 'wrong-password') {
    lines.push('Wrong password — fix the Keychain entry, then run scripts/setup.sh | color=#c0392b');
  } else if (state.lastCode && state.lastCode !== 'ok' && state.lastCode !== 'reset') {
    lines.push(`Last attempt: ${state.lastCode} | color=#c0392b`);
  }
  lines.push('---');
  lines.push(action('Refresh now', ' param2="--refresh"'));
  if (paused) lines.push(action('Resume auto-refresh', ' param2="--resume"'));
  else lines.push(action('Pause 30 min', ' param2="--pause" param3="30"'));
  lines.push(`Open web UI | href=https://${HOST}`);
  process.stdout.write(lines.join('\n') + '\n');
}

// ---------- decide + measure (holds the login lock for the whole attempt) ----------
async function maybeMeasure() {
  const res = await withLock(LOGIN_LOCK, async () => {
    // Decide AND reserve in one state transaction, so a Pause/Refresh landing
    // between the check and the reservation cannot slip a login through. `go`
    // is captured from the mutator; `reserved` is null if the state lock failed.
    let go = false;
    let mac = null; // the pin this attempt is for; the result is only kept if it still is
    const reserved = await updateState((s) => {
      const now = Date.now();
      mac = pairedMac(s, HOST);
      if (!mac) return s; // unpaired: never log in
      const paused = s.pauseUntil && now < s.pauseUntil;
      const sinceAttempt = s.lastAttemptTs ? now - s.lastAttemptTs : Infinity;
      const withinFloor = sinceAttempt < LOGIN_TTL; // 5-min floor, incl. --refresh
      const refreshReq = !!s.refreshRequest;
      const authBlocked = s.lastCode === 'wrong-password';
      const backoffActive = s.nextTryTs && now < s.nextTryTs;
      // refresh overrides the auth block + backoff, but never the floor or pause.
      go = !paused && !withinFloor && (refreshReq || (!authBlocked && !backoffActive));
      if (!go) return s;
      s.lastAttemptTs = now; // record the attempt before logging in (survives crashes)
      if (refreshReq) delete s.refreshRequest; // consume the one-shot request
      return s;
    });
    if (!reserved || !go) return; // state lock failed, or decided not to log in

    let r = null;
    let code = null;
    try {
      r = await readBattery({ host: HOST, expectMac: mac });
    } catch (e) {
      code = e instanceof ProbeError ? e.code : 'error';
    }
    // Left the modem mid-attempt (checked before the password is typed): not the
    // modem's fault, so no lastCode/backoff.
    if (IDENTITY_CODES.has(code)) return;
    // Still on the same modem afterwards? If not, a success may not be the modem's
    // and a failure (timeout, …) is the network switch, not the modem: drop both.
    // lastAttemptTs stays (an attempt did happen), so the floor still applies.
    if (!isModem(await observeGateway(HOST), HOST, mac)) return;
    await updateState((x) => {
      if (pairedMac(x, HOST) !== mac) return x; // re-paired meanwhile
      if (r) {
        return {
          ...x,
          percent: r.percent,
          charging: r.charging,
          signal: r.signal,
          model: r.model,
          ts: Date.now(),
          failCount: 0,
          nextTryTs: 0,
          lastCode: 'ok',
        };
      }
      return recordFailure(x, code);
    });
  });
  return res.acquired; // false -> another login is in progress; just render the cache
}

// Failure policy for a login attempt against the pinned modem (poller and --pair).
function recordFailure(x, code) {
  x.lastCode = code;
  if (code === 'wrong-password' || code === 'no-password') {
    x.nextTryTs = Date.now() + 24 * 3600 * 1000; // blocked until --reset-auth / --refresh
  } else if (code === 'session-busy') {
    x.nextTryTs = Date.now() + LOGIN_TTL; // retry after the floor; keep the cached value
  } else {
    const n = (x.failCount || 0) + 1;
    x.failCount = n;
    x.nextTryTs = Date.now() + BACKOFF_MIN[Math.min(n - 1, BACKOFF_MIN.length - 1)] * 60000;
  }
  return x;
}
const AUTH_CODES = new Set(['wrong-password', 'no-password']);

// ---------- pairing (explicit, from a terminal on the modem's Wi-Fi) ----------
// The trust for the first password send is the user saying "I'm on the modem"
// (optionally confirmed by the MAC they pass). We then require: the observed
// gateway MAC matches that MAC if given, the login succeeds, the device reports
// model M7000, and the gateway is unchanged afterwards. Only then is the MAC
// pinned. A failed pairing keeps the previous pin. Ignores the 5-min floor and
// Pause (explicit one-shot) but holds the login lock like every other login.
async function pair(expected) {
  const want = expected === undefined ? undefined : normMac(expected);
  if (expected !== undefined && !want) throw new ProbeError('bad-mac', `not a MAC address: ${expected}`);
  const obs = await observeGateway(HOST);
  if (!obs.wifi) throw new ProbeError('not-on-wifi', 'no Wi-Fi interface found');
  if (obs.router !== HOST) {
    throw new ProbeError('not-on-wifi', `Wi-Fi's router is ${obs.router || 'unknown'}, not ${HOST} (connect to the modem's Wi-Fi first)`);
  }
  if (!obs.iface) {
    throw new ProbeError('not-on-wifi', `Wi-Fi's router is ${HOST}, but the route to it could not be read — try again`);
  }
  if (obs.iface !== obs.wifi) {
    throw new ProbeError(
      'not-on-wifi',
      `Wi-Fi's router is ${HOST}, but traffic to it goes via ${obs.iface}, not ${obs.wifi}` +
        ' — another connection (e.g. wired LAN on the same subnet) holds that route; disconnect it and retry'
    );
  }
  if (!obs.mac) throw new ProbeError('no-mac', `could not read the MAC of ${HOST} from ARP`);
  if (want && want !== obs.mac) {
    throw new ProbeError('mac-mismatch', `gateway MAC is ${obs.mac}, not ${want} — not pairing`);
  }
  const res = await withLock(LOGIN_LOCK, async () => {
    // Reserve the attempt (floor for the poller) — or do not log in at all. A
    // pending Refresh for this same modem is consumed (this login is that
    // refresh); one queued for another pinned modem is left alone.
    let prevPin = null;
    const reserved = await updateState((s) => {
      prevPin = pairedMac(s, HOST);
      s.lastAttemptTs = Date.now();
      if (prevPin === obs.mac) delete s.refreshRequest;
      return s;
    });
    if (!reserved) throw new ProbeError('state-busy', 'could not reserve the attempt (state locked) — try again');
    let r;
    try {
      r = await readBattery({ host: HOST, expectMac: obs.mac });
    } catch (e) {
      // Re-pairing the modem that is already pinned with a bad password: record it
      // like the poller would, so it does not retry that password in 5 minutes.
      // (New pairings / other MACs never touch the existing pin's auth state.)
      if (e instanceof ProbeError && AUTH_CODES.has(e.code) && prevPin === obs.mac &&
          isModem(await observeGateway(HOST), HOST, obs.mac)) {
        // Keep the original auth error either way; just say if the block didn't stick.
        try {
          const ok = await updateState((x) => (pairedMac(x, HOST) === obs.mac ? recordFailure(x, e.code) : x));
          if (!ok) e.message += ' (and the retry block could not be saved — state locked)';
        } catch (se) {
          e.message += ` (and the retry block could not be saved — ${se.code || se.message || se})`;
        }
      }
      throw e;
    }
    if (!/M7000/i.test(r.model || '')) {
      throw new ProbeError('not-modem', `logged in, but the device reports model ${r.model ?? 'unknown'}`);
    }
    if (!isModem(await observeGateway(HOST), HOST, obs.mac)) {
      throw new ProbeError('not-modem', 'the network changed during pairing — try again');
    }
    const saved = await updateState((x) => ({
      ...x,
      pair: { host: HOST, mac: obs.mac, ts: Date.now() },
      percent: r.percent,
      charging: r.charging,
      signal: r.signal,
      model: r.model,
      ts: Date.now(),
      failCount: 0,
      nextTryTs: 0,
      lastCode: 'ok',
    }));
    if (!saved) throw new ProbeError('state-busy', 'could not save the pairing (state locked) — try again');
    return r;
  }, { waitMs: 8000 });
  if (!res.acquired) throw new ProbeError('busy-lock', 'another login is in progress — try again shortly');
  return { mac: obs.mac, reading: res.value };
}

// ---------- main ----------
const args = process.argv.slice(2);
const mode = args[0];

if (mode === '--pair') {
  try {
    const { mac, reading } = await pair(args[1]);
    process.stdout.write(`paired with ${reading.model} at ${HOST} (MAC ${mac}), battery ${reading.percent}%\n`);
    process.exit(0);
  } catch (e) {
    const code = e instanceof ProbeError ? e.code : 'error';
    process.stdout.write(`pairing failed [${code}]: ${e.message || e}\n`);
    process.exit(1);
  }
} else if (mode === '--unpair') {
  const res = await withLock(LOGIN_LOCK, () => updateState((s) => {
    delete s.pair;
    delete s.refreshRequest;
    return s;
  }), { waitMs: 8000 });
  const ok = res.acquired && res.value;
  process.stdout.write(ok ? 'unpaired — the menu-bar item stays hidden until you pair again\n' : 'busy; try again\n');
  process.exit(ok ? 0 : 1);
} else if (mode === '--pair-status') {
  const mac = pairedMac(await readState(), HOST);
  process.stdout.write(mac ? `paired: ${HOST} ${mac}\n` : `not paired (${HOST})\n`);
  process.exit(mac ? 0 : 1);
} else if (mode === '--pause') {
  const mins = Number(args[1]) || 30;
  await updateState((s) => ({ ...s, pauseUntil: Date.now() + mins * 60000 }));
} else if (mode === '--resume') {
  await updateState((s) => {
    delete s.pauseUntil;
    return s;
  });
} else if (mode === '--reset-auth') {
  // Called by setup.sh: clear a wrong-password block and queue a fresh attempt.
  const s = await updateState((x) => {
    if (x.lastCode === 'wrong-password') {
      x.lastCode = 'reset';
      x.nextTryTs = 0;
      x.failCount = 0;
    }
    x.refreshRequest = true;
    return x;
  });
  process.stdout.write(s ? 'auth retry queued\n' : 'could not update state (locked); try again\n');
  process.exit(s ? 0 : 1);
} else if (mode === '--refresh') {
  // Only queue when it can actually run: on the target network and not paused.
  // (The decision under the login lock still enforces the floor/auth rules.)
  if (await onTargetNetwork(await readState())) {
    await updateState((s) => {
      const paused = s.pauseUntil && Date.now() < s.pauseUntil;
      if (!paused) s.refreshRequest = true;
      return s;
    });
  }
}

// Render path (default, and after --refresh/--pause/--resume).
if (!(await onTargetNetwork(await readState()))) {
  render({}, { offline: true });
  process.exit(0);
}

await maybeMeasure();

// Re-check right before output (we may have left during login), against the same
// state we then render, so an --unpair in between cannot show a value.
const final = await readState();
if (!(await onTargetNetwork(final))) {
  render({}, { offline: true });
  process.exit(0);
}
render(final);
