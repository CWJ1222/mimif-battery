// coordination.mjs — cross-process locking and atomic state for menu.mjs.
//
// Two locks, both under ~/Library/Caches/modem-battery/:
//   login.lock  — held for the whole measurement (browser login). Long.
//   state.lock  — held only for a read-modify-write of state.json. Milliseconds.
//
// Lock implementation: an O_EXCL lock file whose content is the holder's pid.
// Acquisition is atomic (open 'wx'). If the file exists we check whether the
// recorded pid is still alive; a *live* holder is never displaced (this is the
// real case: a manual Refresh during a timed run). Only a holder whose process
// is gone can be cleared. We do NOT steal on a timer, so a slow-but-alive login
// is never double-run. (A dead-holder recovery has a negligible race that would
// require two brand-new processes to start within the same millisecond right
// after a crash; acceptable for a single-user tool — see README.)

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// MODEM_STATE_DIR overrides the location (used by the tests; the real tool uses
// the default under ~/Library/Caches).
export const DIR = process.env.MODEM_STATE_DIR || path.join(os.homedir(), 'Library', 'Caches', 'modem-battery');
export const STATE = path.join(DIR, 'state.json');
export const LOGIN_LOCK = path.join(DIR, 'login.lock');
export const STATE_LOCK = path.join(DIR, 'state.lock');

async function ensureDir() {
  await fs.mkdir(DIR, { recursive: true, mode: 0o700 });
}

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0); // signal 0 = existence check
    return true;
  } catch (e) {
    return e.code === 'EPERM'; // exists but not ours
  }
}

// Try once to grab the lock. Returns true if held by us afterwards.
//
// The lock file is created via link() from a temp file that ALREADY contains our
// pid, so it is never observed empty — a reader in the acquisition window sees a
// fully-formed lock, not empty content that could be mistaken for a dead holder.
async function tryAcquire(lockPath) {
  const tmp = `${lockPath}.${process.pid}.${Math.random().toString(36).slice(2)}`;
  await fs.writeFile(tmp, String(process.pid), { mode: 0o600 });
  try {
    try {
      await fs.link(tmp, lockPath); // atomic; EEXIST if already held
      return true;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
    // Exists — is the holder still alive?
    let holder = NaN;
    try {
      holder = parseInt(await fs.readFile(lockPath, 'utf8'), 10);
    } catch {
      // unreadable — treat as a live holder (do not displace on uncertainty)
      return false;
    }
    if (alive(holder)) return false; // live holder: never displace
    // Dead holder: remove and re-link once. If someone else re-created it in
    // between, link() fails with EEXIST and we back off.
    try {
      await fs.rm(lockPath, { force: true });
      await fs.link(tmp, lockPath);
      return true;
    } catch {
      return false;
    }
  } finally {
    await fs.rm(tmp, { force: true }).catch(() => {});
  }
}

// Run fn while holding lockPath. If the lock can't be acquired, returns
// { acquired: false }; otherwise { acquired: true, value: <fn result> }.
// waitMs > 0 polls for the lock up to that long.
export async function withLock(lockPath, fn, { waitMs = 0, pollMs = 100 } = {}) {
  await ensureDir();
  const deadline = Date.now() + waitMs;
  let held = await tryAcquire(lockPath);
  while (!held && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollMs));
    held = await tryAcquire(lockPath);
  }
  if (!held) return { acquired: false };
  try {
    return { acquired: true, value: await fn() };
  } finally {
    // Release only if we still own it (defensive).
    try {
      const cur = parseInt(await fs.readFile(lockPath, 'utf8'), 10);
      if (cur === process.pid) await fs.rm(lockPath, { force: true });
    } catch {}
  }
}

// state.json read/write (raw; callers serialize via STATE_LOCK).
export async function readState() {
  try {
    return JSON.parse(await fs.readFile(STATE, 'utf8'));
  } catch {
    return {};
  }
}
async function writeStateRaw(s) {
  await ensureDir();
  const tmp = `${STATE}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(s), { mode: 0o600 });
  await fs.rename(tmp, STATE);
}

// Atomic read-modify-write of state under STATE_LOCK. mutator(state) -> newState
// (or mutates in place and returns it). Serializes against every other state
// change (Pause/Resume, --reset-auth, a measurement merging its result), so
// concurrent writers never lose each other's fields. Returns the saved state,
// or null if the state lock could not be taken.
export async function updateState(mutator, opts = {}) {
  const res = await withLock(
    STATE_LOCK,
    async () => {
      const cur = await readState();
      const next = (await mutator(cur)) || cur;
      await writeStateRaw(next);
      return next;
    },
    { waitMs: 2000, ...opts }
  );
  return res.acquired ? res.value : null;
}
