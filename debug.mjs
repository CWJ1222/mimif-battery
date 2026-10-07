// debug.mjs — diagnostic: print selected battery fields or a stable error code.
// Never dump raw device status or exception messages containing local paths.
//
//   MODEM_HOST=192.168.0.1 node debug.mjs

import { readBattery, ProbeError } from './probe.mjs';
import { LOGIN_LOCK, withLock } from './coordination.mjs';

const host = process.env.MODEM_HOST || '192.168.0.1';

try {
  const res = await withLock(LOGIN_LOCK, () => readBattery({ host }), { waitMs: 8000 });
  if (!res.acquired) {
    process.stdout.write(JSON.stringify({ ok: false, code: 'busy-lock', error: 'another login is in progress' }, null, 2) + '\n');
    process.exitCode = 1;
  } else {
    process.stdout.write(JSON.stringify(res.value, null, 2) + '\n');
  }
} catch (e) {
  const code = e instanceof ProbeError ? e.code : 'error';
  process.stdout.write(JSON.stringify({ ok: false, code }, null, 2) + '\n');
  process.exitCode = 1;
}
