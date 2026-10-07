// battery.mjs — thin CLI over probe.mjs. Prints one JSON line with the battery
// reading, for the integration smoke test and ad-hoc use.
//
//   MODEM_HOST=192.168.0.1 node battery.mjs
//   -> {"ok":true,"percent":80,"charging":false,"connected":true,"signal":4,"model":"M7000"}
//   -> {"ok":false,"code":"session-busy","error":"..."}  (exit code 1)
//
// Acquires the shared login lock so it never logs in at the same time as the
// SwiftBar poller. The password is read from the Keychain inside probe.mjs.

import { readBattery, ProbeError } from './probe.mjs';
import { LOGIN_LOCK, withLock } from './coordination.mjs';

const host = process.env.MODEM_HOST || '192.168.0.1';

try {
  const res = await withLock(LOGIN_LOCK, () => readBattery({ host }), { waitMs: 8000 });
  if (!res.acquired) {
    process.stdout.write(JSON.stringify({ ok: false, code: 'busy-lock', error: 'another login is in progress' }) + '\n');
    process.exitCode = 1;
  } else {
    process.stdout.write(JSON.stringify({ ok: true, ...res.value }) + '\n');
  }
} catch (e) {
  const code = e instanceof ProbeError ? e.code : 'error';
  process.stdout.write(JSON.stringify({ ok: false, code, error: e.message || String(e) }) + '\n');
  process.exitCode = 1;
}
