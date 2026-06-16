const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const MARKETPLACE_ID = 'grik.ricochet';
const GITHUB_REPO = 'Grik-ai/ricochet';
const DEFAULT_MANIFEST_URL = `https://github.com/${GITHUB_REPO}/releases/latest/download/latest.json`;
const SUPPORTED_EDITORS = [
  { id: 'code', command: 'code', name: 'VS Code' },
  { id: 'cursor', command: 'cursor', name: 'Cursor' },
  { id: 'windsurf', command: 'windsurf', name: 'Windsurf' },
];

function parseArgs(argv) {
  const options = {
    editor: 'all',
    version: 'latest',
    dryRun: false,
    yes: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--yes' || arg === '-y') {
      options.yes = true;
    } else if (arg === '--editor') {
      options.editor = requiredValue(argv, ++index, '--editor');
    } else if (arg.startsWith('--editor=')) {
      options.editor = arg.slice('--editor='.length);
    } else if (arg === '--version') {
      options.version = requiredValue(argv, ++index, '--version');
    } else if (arg.startsWith('--version=')) {
      options.version = arg.slice('--version='.length);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (!['all', ...SUPPORTED_EDITORS.map((editor) => editor.id)].includes(options.editor)) {
    throw new Error(`Unsupported editor "${options.editor}". Use code, cursor, windsurf, or all.`);
  }

  return options;
}

function requiredValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith('--')) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

function manifestUrlForVersion(version, env = process.env) {
  if (env.RICOCHET_INSTALL_MANIFEST_URL) {
    return env.RICOCHET_INSTALL_MANIFEST_URL;
  }
  if (!version || version === 'latest') {
    return DEFAULT_MANIFEST_URL;
  }
  const tag = version.startsWith('v') ? version : `v${version}`;
  return `https://github.com/${GITHUB_REPO}/releases/download/${tag}/latest.json`;
}

function selectSupportedEditors(requestedEditor) {
  if (requestedEditor === 'all') return SUPPORTED_EDITORS;
  return SUPPORTED_EDITORS.filter((editor) => editor.id === requestedEditor);
}

function findExecutable(command, env = process.env, platform = process.platform) {
  const pathValue = env.PATH || '';
  const pathExt = platform === 'win32'
    ? (env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';')
    : [''];

  for (const directory of pathValue.split(path.delimiter)) {
    if (!directory) continue;
    for (const extension of pathExt) {
      const candidate = path.join(directory, platform === 'win32' ? `${command}${extension.toLowerCase()}` : command);
      if (isExecutable(candidate)) return candidate;
      if (platform === 'win32') {
        const upperCandidate = path.join(directory, `${command}${extension.toUpperCase()}`);
        if (isExecutable(upperCandidate)) return upperCandidate;
      }
    }
  }

  return null;
}

function isExecutable(filePath) {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function detectEditors(requestedEditor, env = process.env) {
  return selectSupportedEditors(requestedEditor)
    .map((editor) => ({
      ...editor,
      path: findExecutable(editor.command, env),
    }))
    .filter((editor) => editor.path);
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: { accept: 'application/json' },
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: HTTP ${response.status}`);
  }
  return response.json();
}

async function downloadFile(url, destination) {
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`Failed to download ${url}: HTTP ${response.status}`);
  }

  await fs.promises.mkdir(path.dirname(destination), { recursive: true });
  await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(destination));
}

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

function validateManifest(manifest) {
  if (!manifest || typeof manifest !== 'object') {
    throw new Error('Release manifest is empty or invalid.');
  }
  if (!manifest.version || !manifest.vsix_url || !manifest.sha256) {
    throw new Error('Release manifest must include version, vsix_url, and sha256.');
  }
  if (manifest.marketplace_id && manifest.marketplace_id !== MARKETPLACE_ID) {
    throw new Error(`Release manifest marketplace_id must be ${MARKETPLACE_ID}.`);
  }
}

function verifyChecksum(filePath, expectedSha256) {
  const actual = sha256File(filePath);
  if (actual.toLowerCase() !== String(expectedSha256).toLowerCase()) {
    throw new Error(`Checksum mismatch for ${path.basename(filePath)}. Expected ${expectedSha256}, got ${actual}.`);
  }
}

function installExtension(editor, vsixPath, dryRun = false) {
  const args = ['--install-extension', vsixPath];
  if (dryRun) {
    return { ok: true, command: `${editor.path} ${args.join(' ')}` };
  }

  const result = spawnSync(editor.path, args, { stdio: 'inherit' });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${editor.name} installer exited with status ${result.status}.`);
  }
  return { ok: true, command: `${editor.path} ${args.join(' ')}` };
}

async function runInstaller(argv = process.argv.slice(2), io = console, env = process.env) {
  const options = parseArgs(argv);
  if (options.help) {
    io.log(helpText());
    return 0;
  }

  const manifestUrl = manifestUrlForVersion(options.version, env);
  io.log(`Fetching Ricochet release manifest: ${manifestUrl}`);
  const manifest = await fetchJson(manifestUrl);
  validateManifest(manifest);

  const editors = detectEditors(options.editor, env);
  if (editors.length === 0) {
    const requested = options.editor === 'all' ? 'VS Code, Cursor, or Windsurf' : options.editor;
    throw new Error(`No supported editor CLI found for ${requested}. Install one of them or add its command to PATH. Manual install: https://marketplace.visualstudio.com/items?itemName=${MARKETPLACE_ID}`);
  }

  io.log(`Ricochet ${manifest.version} will be installed into: ${editors.map((editor) => editor.name).join(', ')}`);
  if (options.dryRun) {
    editors.forEach((editor) => {
      const command = installExtension(editor, String(manifest.vsix_url), true).command;
      io.log(`[dry-run] ${command}`);
    });
    return 0;
  }

  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ricochet-install-'));
  const vsixPath = path.join(tempDir, `ricochet-${manifest.version}.vsix`);

  try {
    io.log(`Downloading ${manifest.vsix_url}`);
    await downloadFile(String(manifest.vsix_url), vsixPath);
    verifyChecksum(vsixPath, String(manifest.sha256));
    for (const editor of editors) {
      io.log(`Installing Ricochet into ${editor.name}`);
      installExtension(editor, vsixPath, false);
    }
    io.log('Ricochet extension installed.');
    return 0;
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

function helpText() {
  return [
    'Ricochet installer',
    '',
    'Usage:',
    '  ricochet-install [--editor code|cursor|windsurf|all] [--version x.y.z] [--dry-run] [--yes]',
    '',
    'Examples:',
    '  ricochet-install',
    '  ricochet-install --editor cursor',
    '  ricochet-install --version 0.1.0',
  ].join('\n');
}

module.exports = {
  DEFAULT_MANIFEST_URL,
  GITHUB_REPO,
  MARKETPLACE_ID,
  SUPPORTED_EDITORS,
  detectEditors,
  findExecutable,
  helpText,
  installExtension,
  manifestUrlForVersion,
  parseArgs,
  runInstaller,
  selectSupportedEditors,
  validateManifest,
  verifyChecksum,
};
