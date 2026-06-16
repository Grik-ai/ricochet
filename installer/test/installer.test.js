const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  detectEditors,
  findExecutable,
  manifestUrlForVersion,
  parseArgs,
  selectSupportedEditors,
  validateManifest,
  verifyChecksum,
} = require('../lib/installer');

test('parseArgs supports editor, version, dry-run, and yes', () => {
  assert.deepEqual(parseArgs(['--editor', 'cursor', '--version=0.1.0', '--dry-run', '-y']), {
    editor: 'cursor',
    version: '0.1.0',
    dryRun: true,
    yes: true,
    help: false,
  });
});

test('parseArgs rejects unsupported editors', () => {
  assert.throws(() => parseArgs(['--editor', 'unknown']), /Unsupported editor/);
});

test('manifestUrlForVersion supports latest, explicit version, and env override', () => {
  assert.equal(
    manifestUrlForVersion('latest', {}),
    'https://github.com/Grik-ai/ricochet/releases/latest/download/latest.json',
  );
  assert.equal(
    manifestUrlForVersion('0.2.0', {}),
    'https://github.com/Grik-ai/ricochet/releases/download/v0.2.0/latest.json',
  );
  assert.equal(
    manifestUrlForVersion('v0.2.0', {}),
    'https://github.com/Grik-ai/ricochet/releases/download/v0.2.0/latest.json',
  );
  assert.equal(
    manifestUrlForVersion('latest', { RICOCHET_INSTALL_MANIFEST_URL: 'https://example.com/latest.json' }),
    'https://example.com/latest.json',
  );
});

test('selectSupportedEditors returns active group first by request', () => {
  assert.deepEqual(selectSupportedEditors('cursor').map((editor) => editor.id), ['cursor']);
  assert.deepEqual(selectSupportedEditors('all').map((editor) => editor.id), ['code', 'cursor', 'windsurf']);
});

test('findExecutable and detectEditors find editor commands on PATH', async () => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ricochet-installer-test-'));
  const command = path.join(dir, process.platform === 'win32' ? 'cursor.cmd' : 'cursor');
  await fs.promises.writeFile(command, process.platform === 'win32' ? '@echo off\r\n' : '#!/bin/sh\n');
  await fs.promises.chmod(command, 0o755);

  const env = { PATH: dir, PATHEXT: '.CMD;.EXE' };
  assert.equal(findExecutable('cursor', env), command);
  assert.deepEqual(detectEditors('cursor', env).map((editor) => editor.id), ['cursor']);

  await fs.promises.rm(dir, { recursive: true, force: true });
});

test('validateManifest requires release fields and marketplace id', () => {
  assert.doesNotThrow(() => validateManifest({
    version: '0.1.0',
    marketplace_id: 'grik.ricochet',
    vsix_url: 'https://example.com/ricochet.vsix',
    sha256: 'abc',
  }));
  assert.throws(() => validateManifest({}), /version, vsix_url, and sha256/);
  assert.throws(() => validateManifest({
    version: '0.1.0',
    marketplace_id: 'other.extension',
    vsix_url: 'https://example.com/ricochet.vsix',
    sha256: 'abc',
  }), /marketplace_id/);
});

test('verifyChecksum rejects mismatches', async () => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ricochet-checksum-test-'));
  const file = path.join(dir, 'sample.vsix');
  await fs.promises.writeFile(file, 'ricochet');
  assert.doesNotThrow(() => verifyChecksum(file, 'f025b94145fc8675ec568f14f9295a69a854b524768ab3f032aa9848e670961d'));
  assert.throws(() => verifyChecksum(file, 'bad'), /Checksum mismatch/);
  await fs.promises.rm(dir, { recursive: true, force: true });
});
