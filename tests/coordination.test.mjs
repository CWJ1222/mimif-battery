// Regression tests for the trickiest fixes from the code review: the PID-liveness
// lock and the serialized state merge. No external deps (node:test built-in).
//
//   node --test
//
// Uses MODEM_STATE_DIR so it never touches the real ~/Library/Caches state.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = path.join(os.tmpdir(), `modem-battery-test-${process.pid}`);
process.env.MODEM_STATE_DIR = TMP;

// Import AFTER setting the env so DIR picks up the temp location.
const { withLock, updateState, readState, STATE_LOCK, LOGIN_LOCK, STATE } = await import('../coordination.mjs');

before(async () => {
  await fs.mkdir(TMP, { recursive: true });
});
after(async () => {
  await fs.rm(TMP, { recursive: true, force: true });
});
beforeEach(async () => {
  await fs.rm(STATE, { force: true }).catch(() => {});
  await fs.rm(LOGIN_LOCK, { force: true }).catch(() => {});
  await fs.rm(STATE_LOCK, { force: true }).catch(() => {});
});

test('a live holder is never displaced', async () => {
  // pid 1 (launchd) is always alive -> lock must be treated as held.
  await fs.writeFile(LOGIN_LOCK, '1');
  const res = await withLock(LOGIN_LOCK, async () => 'ran');
  assert.equal(res.acquired, false, 'should not acquire a lock held by a live pid');
});

test('the lock file always carries the holder pid (never observed empty)', async () => {
  // link()-based acquisition means a concurrent reader never sees an empty lock
  // that it could mistake for a dead holder (the round-2 P1 regression).
  await withLock(LOGIN_LOCK, async () => {
    const c = await fs.readFile(LOGIN_LOCK, 'utf8');
    assert.equal(c, String(process.pid));
  });
});

test('a dead holder can be reclaimed', async () => {
  await fs.writeFile(LOGIN_LOCK, '999999'); // not a live pid
  const res = await withLock(LOGIN_LOCK, async () => 'ran');
  assert.equal(res.acquired, true);
  assert.equal(res.value, 'ran');
});

test('updateState serializes concurrent writers (no lost update)', async () => {
  await Promise.all([
    updateState((s) => ({ ...s, n: (s.n || 0) + 1 })),
    updateState((s) => ({ ...s, n: (s.n || 0) + 1 })),
    updateState((s) => ({ ...s, n: (s.n || 0) + 1 })),
  ]);
  const s = await readState();
  assert.equal(s.n, 3, 'all three increments must apply');
});

test('a measurement result merge preserves pauseUntil', async () => {
  // Pause first, then a measurement result comes in and must not wipe the pause.
  const until = Date.now() + 30 * 60000;
  await updateState((s) => ({ ...s, pauseUntil: until }));
  await updateState((s) => ({ ...s, percent: 50, charging: false, ts: Date.now(), lastCode: 'ok' }));
  const s = await readState();
  assert.equal(s.pauseUntil, until, 'pauseUntil must survive a result merge');
  assert.equal(s.percent, 50);
});
