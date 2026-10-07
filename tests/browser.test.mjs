import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveChromePath } from '../browser.mjs';

test('browser resolution honors overrides, reuses an executable cache, and falls back', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mimif-browser-'));
  const legacyPath = path.join(dir, 'cached-chrome');
  const installedPath = path.join(dir, 'package-chrome');
  try {
    const options = { override: '', legacyPath, installedPath };
    assert.equal(resolveChromePath(options), installedPath, 'missing cache');
    await writeFile(legacyPath, '', { mode: 0o600 });
    assert.equal(resolveChromePath(options), installedPath, 'non-executable cache');
    await rm(legacyPath);
    await writeFile(legacyPath, '', { mode: 0o700 });
    assert.equal(resolveChromePath(options), legacyPath, 'existing working cache');
    assert.equal(resolveChromePath({ ...options, override: '/custom/chrome' }), '/custom/chrome');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
