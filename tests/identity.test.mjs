// Tests for the paired-modem gate: another router at the same IP must never show
// the item or receive the password. No modem needed — the decision is pure, and
// the end-to-end checks use a pin that no real gateway has.
//
//   node --test

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileP = promisify(execFile);
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const TMP = path.join(os.tmpdir(), `modem-battery-identity-test-${process.pid}`);
process.env.MODEM_STATE_DIR = TMP;

const { normMac, parseArp, pairedMac, isModem } = await import('../identity.mjs');
const { readBattery } = await import('../probe.mjs');
const STATE = path.join(TMP, 'state.json');

before(async () => fs.mkdir(TMP, { recursive: true }));
after(async () => fs.rm(TMP, { recursive: true, force: true }));
beforeEach(async () => fs.rm(STATE, { force: true }));

const writeState = (s) => fs.writeFile(STATE, JSON.stringify(s));
const OLD_READING = { percent: 100, charging: true, model: 'M7000', ts: Date.now() - 22 * 3600e3, lastCode: 'unreachable' };
const BOGUS = '02:00:00:00:00:01'; // locally administered; no real gateway has it

test('normMac pads macOS short octets and rejects junk', () => {
  assert.equal(normMac('02:00:00:9:f:ab'), '02:00:00:09:0f:ab');
  assert.equal(normMac('02:00:00:00:00:AB'), '02:00:00:00:00:ab');
  assert.equal(normMac('02-00-00-00-00-ab'), '02:00:00:00:00:ab');
  assert.equal(normMac('(incomplete)'), null);
  assert.equal(normMac('02:00:00:00:00'), null);
  assert.equal(normMac('0:0:0:0:0:0'), null);
  assert.equal(normMac('ff:ff:ff:ff:ff:ff'), null);
  assert.equal(normMac(undefined), null);
});

test('parseArp takes exactly one complete entry for that IP on that device', () => {
  const ip = '192.168.0.1';
  assert.equal(parseArp('? (192.168.0.1) at 02:00:00:00:00:ab on en0 ifscope [ethernet]\n', ip, 'en0'), '02:00:00:00:00:ab');
  assert.equal(parseArp('192.168.0.1 (192.168.0.1) -- no entry on en0\n', ip, 'en0'), null);
  assert.equal(parseArp('? (192.168.0.1) at (incomplete) on en0 ifscope [ethernet]\n', ip, 'en0'), null);
  assert.equal(parseArp('? (192.168.0.1) at 02:00:00:00:00:ab on en7 ifscope [ethernet]\n', ip, 'en0'), null);
  assert.equal(parseArp('? (192.168.0.10) at 02:00:00:00:00:ab on en0 ifscope [ethernet]\n', ip, 'en0'), null);
  const two = '? (192.168.0.1) at 02:00:00:00:00:ab on en0 [ethernet]\n? (192.168.0.1) at 1:2:3:4:5:6 on en0 [ethernet]\n';
  assert.equal(parseArp(two, ip, 'en0'), null, 'ambiguous -> reject');
});

test('pairedMac is per HOST', () => {
  assert.equal(pairedMac({}, '192.168.0.1'), null);
  assert.equal(pairedMac({ pair: { host: '192.168.0.1', mac: '02:00:00:00:00:AB' } }, '192.168.0.1'), '02:00:00:00:00:ab');
  assert.equal(pairedMac({ pair: { host: '192.168.1.1', mac: '02:00:00:00:00:ab' } }, '192.168.0.1'), null);
});

test('isModem: same IP is not enough — the MAC must equal the pin', () => {
  const host = '192.168.0.1';
  const obs = { wifi: 'en0', router: host, iface: 'en0', mac: '02:00:00:00:00:ab' };
  assert.equal(isModem(obs, host, '02:00:00:00:00:ab'), true);
  assert.equal(isModem(obs, host, BOGUS), false, 'other router at the same IP');
  assert.equal(isModem(obs, host, null), false, 'unpaired');
  assert.equal(isModem({ ...obs, mac: null }, host, '02:00:00:00:00:ab'), false, 'no ARP entry');
  assert.equal(isModem({ ...obs, iface: 'en7' }, host, '02:00:00:00:00:ab'), false, 'reached over the wire');
  assert.equal(isModem({ ...obs, router: '10.0.0.1' }, host, '02:00:00:00:00:ab'), false, 'Wi-Fi router is not HOST');
  assert.equal(isModem({ ...obs, wifi: null }, host, '02:00:00:00:00:ab'), false, 'no Wi-Fi device');
});

test('readBattery refuses before touching the Keychain when unpaired', async () => {
  await writeState(OLD_READING);
  await assert.rejects(readBattery({ host: '192.168.0.1' }), { code: 'not-paired' });
});

test('readBattery refuses when the gateway is not the paired modem', async () => {
  // 203.0.113.1 (TEST-NET-3) is never Wi-Fi's router -> not-modem, not no-password.
  await writeState({ ...OLD_READING, pair: { host: '203.0.113.1', mac: BOGUS } });
  await assert.rejects(readBattery({ host: '203.0.113.1' }), { code: 'not-modem' });
});

async function runMenu(extraArgs = [], host = '192.168.0.1') {
  try {
    const r = await execFileP(process.execPath, [path.join(ROOT, 'menu.mjs'), ...extraArgs], {
      env: { ...process.env, MODEM_STATE_DIR: TMP, MODEM_HOST: host },
      timeout: 20000,
    });
    return { code: 0, stdout: r.stdout };
  } catch (e) {
    return { code: e.code, stdout: e.stdout };
  }
}

test('menu hides (empty output) when unpaired, even with an old reading cached', async () => {
  await writeState(OLD_READING);
  const { stdout } = await runMenu();
  assert.equal(stdout, '\n');
});

test('menu hides when the pin is some other MAC', async () => {
  await writeState({ ...OLD_READING, pair: { host: '192.168.0.1', mac: BOGUS } });
  const { stdout } = await runMenu();
  assert.equal(stdout, '\n');
  const s = JSON.parse(await fs.readFile(STATE, 'utf8'));
  assert.equal(s.lastAttemptTs, undefined, 'no login attempt was reserved');
});

test('--pair-status reports unpaired with exit 1, paired with exit 0', async () => {
  await writeState(OLD_READING);
  let r = await runMenu(['--pair-status']);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /not paired/);
  await writeState({ ...OLD_READING, pair: { host: '192.168.0.1', mac: BOGUS } });
  r = await runMenu(['--pair-status']);
  assert.equal(r.code, 0);
  assert.match(r.stdout, new RegExp(BOGUS));
});

test('--pair rejects a malformed MAC and a gateway that is not on Wi-Fi', async () => {
  let r = await runMenu(['--pair', 'nope']);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /\[bad-mac\]/);
  r = await runMenu(['--pair'], '203.0.113.1');
  assert.equal(r.code, 1);
  assert.match(r.stdout, /\[not-on-wifi\]/);
});

test('--unpair removes the pin', async () => {
  await writeState({ ...OLD_READING, pair: { host: '192.168.0.1', mac: BOGUS } });
  const r = await runMenu(['--unpair']);
  assert.equal(r.code, 0);
  const s = JSON.parse(await fs.readFile(STATE, 'utf8'));
  assert.equal(s.pair, undefined);
  assert.equal(s.percent, 100, 'other state is kept');
});
