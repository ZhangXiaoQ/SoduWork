'use strict';

// Uses the desktop client's existing Electron dependency; no model or network.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { iconGeometry } = require('./product-icon-geometry.cjs');
const { opaqueIconBitmap } = require('./product-icon-bitmap.cjs');
const root = path.resolve(__dirname, '..');
const scriptIndex = process.argv.findIndex(arg => path.resolve(arg) === __filename);
const args = process.argv.slice(scriptIndex + 1);
if (args.some(arg => !['--check', '--mobile', '--desktop'].includes(arg)) ||
    (args.includes('--mobile') && args.includes('--desktop'))) {
  throw new Error('Usage: node tools/generate-product-icons.cjs [--check] [--mobile | --desktop]');
}

if (!process.versions.electron) {
  const electron = require(require.resolve('electron', { paths: [path.join(root, 'client')] }));
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  if (process.platform === 'linux') env.GSETTINGS_BACKEND = 'memory';
  const flags = process.platform === 'linux' ? ['--no-sandbox', '--ozone-platform=headless'] : [];
  const result = spawnSync(electron, [...flags, __filename, ...args], { env, stdio: 'inherit', timeout: 60000 });
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}

const { app, BrowserWindow, nativeImage } = require('electron');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-icons-'));
app.setPath('userData', profile);
app.setPath('sessionData', profile);
app.disableHardwareAcceleration();
const source = fs.readFileSync(path.join(root, 'docs/design/brand/app-tile.png'));
const tile = nativeImage.createFromBuffer(source);
if (tile.isEmpty() || tile.getSize().width !== 1024 || tile.getSize().height !== 1024) {
  throw new Error('The approved app tile must be a 1024 × 1024 PNG.');
}
const desktop = nativeImage.createFromPath(path.join(root, 'docs/design/brand/icon-desktop-compact.png'));
const desktopSize = desktop.getSize();
if (desktop.isEmpty() || desktopSize.width !== desktopSize.height || desktopSize.width < 1024) {
  throw new Error('The transparent desktop mark must be a square PNG of at least 1024 pixels.');
}
const checking = args.includes('--check');
const mobileOnly = args.includes('--mobile');
const desktopOnly = args.includes('--desktop');
const targets = new Map();
const add = (file, size, opaque = false, artwork = 'tile') => targets.set(file, { file, size, opaque, artwork });
const iconSizes = [16, 24, 32, 48, 64, 128, 256];

if (!mobileOnly) {
  add('client/icon.png', 1024, false, 'desktop');
  for (const size of [...iconSizes, 512]) add(`client/build/icons/${size}x${size}.png`, size, false, 'desktop');
  add('hub-frontend/public/soduwork.png', 256, false, 'desktop');
}
if (!desktopOnly) {
  add('mobile/assets/brand/soduwork.png', 256);
  add('mobile/web/favicon.png', 32);
  for (const size of [192, 512]) {
    add(`mobile/web/icons/Icon-${size}.png`, size);
    add(`mobile/web/icons/Icon-maskable-${size}.png`, size, true);
  }
  for (const [density, size] of Object.entries({ mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 })) {
    add(`mobile/android/app/src/main/res/mipmap-${density}/ic_launcher.png`, size);
  }
  const appIcons = 'mobile/ios/Runner/Assets.xcassets/AppIcon.appiconset';
  const catalog = JSON.parse(fs.readFileSync(path.join(root, appIcons, 'Contents.json'), 'utf8'));
  for (const image of catalog.images) {
    const size = Number(image.size.split('x')[0]) * Number(image.scale.slice(0, -1));
    add(`${appIcons}/${image.filename}`, size, true);
  }
}

function ico(frames) {
  const header = Buffer.alloc(6 + frames.length * 16);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(frames.length, 4);
  let offset = header.length;
  frames.forEach(({ size, png }, index) => {
    const entry = 6 + index * 16;
    header[entry] = header[entry + 1] = size === 256 ? 0 : size;
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(png.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += png.length;
  });
  return Buffer.concat([header, ...frames.map(frame => frame.png)]);
}

function samePixels(actual, expected) {
  const image = nativeImage.createFromBuffer(actual);
  return !image.isEmpty() && JSON.stringify(image.getSize()) === JSON.stringify(expected.getSize()) &&
    image.toBitmap().equals(expected.toBitmap());
}

async function main() {
  await app.whenReady();
  // iOS disallows alpha, and maskable icons need an opaque full-bleed background.
  const window = new BrowserWindow({ show: false, webPreferences: {
    offscreen: true, contextIsolation: true, nodeIntegration: false, sandbox: true
  } });
  const opaque = nativeImage.createFromBitmap(opaqueIconBitmap(tile.toBitmap()), {width: 1024, height: 1024});
  let normalizedDesktop;
  const geometry = iconGeometry(desktop.toBitmap(), desktopSize.width, desktopSize.height);
  const desktopSource = desktop.crop(geometry.crop).toDataURL();
  try {
    await window.loadURL('data:text/html,<html></html>');
    const data = await window.webContents.executeJavaScript(`(async () => {
      const mark = new Image();
      mark.src = ${JSON.stringify(desktopSource)};
      await mark.decode();
      const transparent = document.createElement('canvas');
      transparent.width = transparent.height = 1024;
      const target = ${JSON.stringify(geometry.target)};
      transparent.getContext('2d').drawImage(mark, target.x, target.y, target.width, target.height);
      return { desktop: transparent.toDataURL('image/png') };
    })()`);
    normalizedDesktop = nativeImage.createFromDataURL(data.desktop);
  } finally {
    window.destroy();
  }
  const cache = new Map();
  const resized = (size, solid = false, artwork = 'tile') => {
    const key = `${artwork}:${size}:${solid}`;
    const image = solid ? opaque : artwork === 'desktop' ? normalizedDesktop : tile;
    if (!cache.has(key)) cache.set(key, image.resize({ width: size, height: size, quality: 'best' }));
    return cache.get(key);
  };
  const errors = [];
  for (const { file, size, opaque: solid, artwork } of targets.values()) {
    const output = path.join(root, file);
    const expected = resized(size, solid, artwork);
    if (checking) {
      if (!fs.existsSync(output) || !samePixels(fs.readFileSync(output), expected)) errors.push(file);
    } else {
      fs.mkdirSync(path.dirname(output), { recursive: true });
      fs.writeFileSync(output, size === 1024 && !solid && artwork === 'tile' ? source : expected.toPNG());
    }
  }
  if (!mobileOnly) {
    const frames = iconSizes.map(size => ({ size, png: resized(size, false, 'desktop').toPNG() }));
    for (const file of ['client/icon.ico', 'hub-frontend/public/favicon.ico']) {
      const output = path.join(root, file);
      if (checking) {
        const actual = fs.existsSync(output) ? fs.readFileSync(output) : Buffer.alloc(0);
        const valid = actual.length >= 6 + frames.length * 16 && actual.readUInt16LE(0) === 0 &&
          actual.readUInt16LE(2) === 1 && actual.readUInt16LE(4) === frames.length;
        if (!valid || frames.some(({ size }, index) => {
          const entry = 6 + index * 16;
          const length = actual.readUInt32LE(entry + 8), offset = actual.readUInt32LE(entry + 12);
          return (actual[entry] || 256) !== size || (actual[entry + 1] || 256) !== size ||
            offset + length > actual.length || !samePixels(actual.subarray(offset, offset + length), resized(size, false, 'desktop'));
        })) errors.push(file);
      } else fs.writeFileSync(output, ico(frames));
    }
  }
  if (errors.length) throw new Error('Icons differ from the approved source: ' + errors.join(', '));
  console.log(JSON.stringify({ ok: true, mode: checking ? 'check' : 'generate', icons: targets.size + (mobileOnly ? 0 : 2) }));
}

main().then(() => app.exit(0), error => { console.error(error); app.exit(1); });
