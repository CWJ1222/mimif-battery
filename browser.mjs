// Reuse the original working cache when available; otherwise use the browser
// revision and architecture expected by the installed Playwright package.
import { accessSync, constants } from 'node:fs';
import os from 'node:os';
import { chromium } from 'playwright-core';

const LEGACY_CHROME = `${os.homedir()}/Library/Caches/ms-playwright/chromium-1228/` +
  'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';

export function resolveChromePath({
  override = process.env.CHROME_PATH,
  legacyPath = LEGACY_CHROME,
  installedPath = chromium.executablePath(),
} = {}) {
  if (override) return override;
  try {
    accessSync(legacyPath, constants.X_OK);
    return legacyPath;
  } catch {
    return installedPath;
  }
}
