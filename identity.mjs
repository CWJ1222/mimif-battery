// identity.mjs — is this Mac on the paired MiFi, and not just any 192.168.0.1?
//
// Many home routers also use 192.168.0.1, so "Wi-Fi's router is HOST" is not
// enough. We pin the modem's gateway MAC (as seen in ARP on the Wi-Fi interface)
// once, explicitly (`node menu.mjs --pair`), and afterwards require it to match.
// Unpaired, mismatched, or unconfirmable -> not the modem (hide, never log in).
//
// This tells an ordinary same-IP router apart from the modem; it is not a
// defence against a device deliberately spoofing the modem's MAC.
//
// Network facts (each call: Wi-Fi device, its DHCP router, the route to HOST,
// and the ARP entry for HOST on that device) come from macOS CLIs; any failure
// yields null, and null never matches.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

async function sh(file, args, timeoutMs = 1500) {
  try {
    const { stdout } = await execFileP(file, args, { timeout: timeoutMs });
    return stdout;
  } catch (e) {
    return typeof e?.stdout === 'string' ? e.stdout : ''; // arp exits 1 on "no entry"
  }
}

// "02:00:00:9:f:ab" (macOS drops leading zeros) -> "02:00:00:09:0f:ab". Rejects
// anything that is not six hex octets, and the all-zero / broadcast addresses.
export function normMac(s) {
  if (typeof s !== 'string') return null;
  const parts = s.trim().toLowerCase().split(/[:-]/);
  if (parts.length !== 6 || !parts.every((p) => /^[0-9a-f]{1,2}$/.test(p))) return null;
  const mac = parts.map((p) => p.padStart(2, '0')).join(':');
  if (mac === '00:00:00:00:00:00' || mac === 'ff:ff:ff:ff:ff:ff') return null;
  return mac;
}

// Parse `arp -n -i <dev> <ip>` output: exactly one complete entry for that IP on
// that device, else null ("no entry", "(incomplete)", other device, ambiguous).
export function parseArp(out, ip, dev) {
  const hits = String(out)
    .split('\n')
    .map((l) => l.match(/^\S+ \(([\d.]+)\) at (\S+) on (\w+)/))
    .filter((m) => m && m[1] === ip && m[3] === dev);
  if (hits.length !== 1) return null;
  return normMac(hits[0][2]);
}

export async function wifiDevice() {
  const out = await sh('/usr/sbin/networksetup', ['-listallhardwareports']);
  return out.match(/Hardware Port:\s*Wi-Fi\s*\nDevice:\s*(\w+)/)?.[1] || null;
}
async function routeInterface(host) {
  const out = await sh('/sbin/route', ['-n', 'get', host]);
  return out.match(/interface:\s*(\w+)/)?.[1] || null;
}
async function interfaceRouter(dev) {
  const out = await sh('/usr/sbin/ipconfig', ['getoption', dev, 'router']);
  return out.trim() || null;
}
async function arpMac(host, dev) {
  return parseArp(await sh('/usr/sbin/arp', ['-n', '-i', dev, host]), host, dev);
}

// Observe the gateway. `mac` is only looked up when HOST is Wi-Fi's router and is
// reached over Wi-Fi; if its ARP entry has expired, one ping re-resolves it.
export async function observeGateway(host) {
  const wifi = await wifiDevice();
  if (!wifi) return { wifi: null, router: null, iface: null, mac: null };
  const [iface, router] = await Promise.all([routeInterface(host), interfaceRouter(wifi)]);
  let mac = null;
  if (router === host && iface === wifi) {
    mac = await arpMac(host, wifi);
    if (!mac) {
      await sh('/sbin/ping', ['-c', '1', '-t', '1', host], 2500);
      mac = await arpMac(host, wifi);
    }
  }
  return { wifi, router, iface, mac };
}

// The pinned MAC for this HOST, or null (unpaired, or paired under another HOST).
export function pairedMac(state, host) {
  const p = state?.pair;
  if (!p || p.host !== host) return null;
  return normMac(p.mac);
}

// Pure decision: on the paired modem iff the old network conditions hold AND the
// gateway MAC equals the pin. Unpaired or unknown MAC -> false.
export function isModem(obs, host, pinned) {
  return !!(
    obs &&
    obs.wifi &&
    obs.router === host &&
    obs.iface === obs.wifi &&
    obs.mac &&
    pinned &&
    obs.mac === pinned
  );
}
