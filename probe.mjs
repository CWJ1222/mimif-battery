// probe.mjs — log into the TP-Link M7000 MiFi web UI and read the battery.
//
// The device reports battery as { connected, charging, voltage } where `voltage`
// is actually the charge level 0-100 (a TP-Link naming quirk). We drive the
// device's OWN login page with headless Chromium so all AES/RSA login crypto is
// done by the page itself, then read the Status page's model and log out.
//
// Exports readBattery(opts) -> { percent, charging, connected, signal, model }.
// Throws a ProbeError with a stable `.code` so callers can react:
//   not-paired | not-modem | no-password | session-busy | login-failed | wrong-password |
//   timeout | unreachable | read-failed
//
// Before the password is even read, and again right before it is typed, the
// gateway must be the paired modem (identity.mjs) — so no caller (menu, the
// battery/debug CLIs) can send it to some other router that also sits at HOST.
//
// The web-UI password is read from the macOS Keychain via `security` inside this
// process (never placed in argv or the environment, so it is not visible to the
// spawned browser or to `ps`).

import { chromium } from 'playwright-core';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolveChromePath } from './browser.mjs';
import { observeGateway, pairedMac, isModem } from './identity.mjs';
import { readState } from './coordination.mjs';

const execFileP = promisify(execFile);

export class ProbeError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
  }
}

// Read the password straight from Keychain into memory. Not via env/argv.
export async function readPassword({ service = 'modem-battery', account = 'admin' } = {}) {
  try {
    const { stdout } = await execFileP('/usr/bin/security', [
      'find-generic-password', '-w', '-s', service, '-a', account,
    ]);
    const pw = stdout.replace(/\n$/, '');
    if (!pw) throw new ProbeError('no-password', 'empty Keychain password');
    return pw;
  } catch (e) {
    if (e instanceof ProbeError) throw e;
    throw new ProbeError('no-password', `Keychain read failed: ${e.message || e}`);
  }
}

// Wrap a promise with a timeout that rejects with ProbeError('timeout').
function withTimeout(promise, ms, label) {
  let t;
  const timeout = new Promise((_, rej) => {
    t = setTimeout(() => rej(new ProbeError('timeout', `${label} exceeded ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

// Throw unless HOST is currently the modem whose MAC is `mac` (null = unpaired).
async function assertModem(host, mac) {
  if (!mac) throw new ProbeError('not-paired', 'no modem paired — run `node menu.mjs --pair` on its Wi-Fi');
  if (!isModem(await observeGateway(host), host, mac)) {
    throw new ProbeError('not-modem', `${host} is not the paired modem on this network`);
  }
}

export async function readBattery({
  host = '192.168.0.1',
  chromePath = resolveChromePath(),
  overallTimeoutMs = 30000,
  cleanupTimeoutMs = 5000,
  service = 'modem-battery',
  account = 'admin',
  // Gateway MAC the modem must have. Default: the pin in state.json. Only
  // `menu.mjs --pair` passes it explicitly (the MAC it is about to pin).
  expectMac,
} = {}) {
  const mac = expectMac !== undefined ? expectMac : pairedMac(await readState(), host);
  await assertModem(host, mac); // before the Keychain is touched
  const password = await readPassword({ service, account });
  const base = `https://${host}`;
  let browser;
  let aborted = false;
  // Launch up front and attach a cleanup hook, so a browser that resolves AFTER
  // the overall timeout has fired still gets closed instead of leaking.
  const launchP = chromium.launch({ executablePath: chromePath, headless: true, timeout: overallTimeoutMs });
  launchP.then((b) => { browser = b; if (aborted) b.close().catch(() => {}); }).catch(() => {});

  const run = async () => {
    const br = await launchP;
    if (aborted) throw new ProbeError('timeout', 'aborted after launch');
    const ctx = await br.newContext({ ignoreHTTPSErrors: true });
    if (aborted) throw new ProbeError('timeout', 'aborted after context');
    const page = await ctx.newPage();
    page.setDefaultTimeout(15000);

    try {
      await page.goto(`${base}/login.html`, { waitUntil: 'domcontentloaded' });
    } catch (e) {
      throw new ProbeError('unreachable', `cannot load login page: ${e.message || e}`);
    }

    // The normal login form (#password) is hidden while another admin session is
    // active — the single-session M7000 shows a different state. Distinguish that
    // from a real failure so the caller can keep showing the cached value.
    try {
      await page.waitForSelector('#password', { state: 'visible', timeout: 9000 });
    } catch {
      const hasHiddenPw = await page
        .evaluate(() => {
          const el = document.querySelector('#password');
          return !!el && el.offsetParent === null;
        })
        .catch(() => false);
      if (hasHiddenPw) throw new ProbeError('session-busy', 'another admin session appears active');
      throw new ProbeError('login-failed', 'login form did not appear');
    }

    // Last check before the password leaves this process: still on the paired
    // modem, and the page was not redirected to another origin.
    await assertModem(host, mac);
    if (new URL(page.url()).host !== host) {
      throw new ProbeError('not-modem', `login page moved to ${new URL(page.url()).host}`);
    }
    await page.fill('#password', password);
    await page.click('#loginBtn');

    const nav = await Promise.race([
      page.waitForURL(/settings\.html/, { timeout: 15000 }).then(() => 'ok').catch(() => null),
      page
        .waitForFunction(
          () => {
            const n = document.querySelector('#noteDiv');
            return n && n.offsetParent !== null && n.textContent.trim() ? n.textContent.trim() : false;
          },
          { timeout: 15000 }
        )
        .then((h) => h.jsonValue())
        .catch(() => null),
    ]);
    if (nav !== 'ok' && !/settings\.html/.test(page.url())) {
      const note = typeof nav === 'string' ? nav : '';
      if (/password|wrong|incorrect|비밀번호/i.test(note)) {
        throw new ProbeError('wrong-password', `login rejected: ${note}`);
      }
      throw new ProbeError('login-failed', note || 'login did not reach the status page');
    }

    await page.waitForFunction(() => typeof window.callJSON === 'function', { timeout: 15000 });
    const status = await page
      .waitForFunction(
        () => {
          try {
            const a = window.Globals?.models?.statusModel?.attributes;
            return a && a.battery ? a : false;
          } catch {
            return false;
          }
        },
        { timeout: 15000 }
      )
      .then((h) => h.jsonValue())
      .catch(() => null);

    if (!status || !status.battery) throw new ProbeError('read-failed', 'status/battery not populated');

    const b = status.battery;
    const percent = typeof b.voltage === 'number' ? b.voltage : null;
    if (percent === null || percent < 0 || percent > 100) {
      throw new ProbeError('read-failed', 'battery percent out of range');
    }
    const out = {
      percent,
      charging: !!b.charging,
      connected: !!b.connected,
      signal: status.wan?.signalStrength ?? null,
      model: status.deviceInfo?.model ?? null,
    };
    return out;
  };

  // Best-effort logout so the single admin session is released for the app/web UI.
  const logout = async () => {
    if (!browser) return;
    try {
      const pages = browser.contexts().flatMap((c) => c.pages());
      const page = pages[0];
      if (page && /settings\.html/.test(page.url())) {
        await withTimeout(
          page.evaluate(
            () =>
              new Promise((resolve) => {
                try {
                  // authModel.logout is synchronous (async:false ajax); resolve after it returns.
                  window.AuthModel?.logout?.();
                } catch {}
                setTimeout(resolve, 300);
              })
          ),
          cleanupTimeoutMs,
          'logout'
        ).catch(() => {});
      }
    } catch {}
  };

  try {
    return await withTimeout(run(), overallTimeoutMs, 'probe');
  } finally {
    aborted = true;
    await logout().catch(() => {});
    // Wait for the browser to exist (even if it launched late) and close it before
    // returning, so the caller's login lock covers the whole browser lifetime and
    // a later run never starts Chromium while this one is still tearing down.
    const b = browser || (await launchP.catch(() => null));
    if (b) await b.close().catch(() => {});
  }
}
