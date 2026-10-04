// Shared helpers of the market scripts: plugin folders, packing, zip writing.
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateRawSync } from 'node:zlib';

/** sdk/market of the BotHub repo (tools, feature parts, dist/). */
export const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
/** BotHub repo root: shared/ (schema, permission catalog) and sdk/dist (test kit). */
export const bothubRoot = resolve(root, '..', '..');
/** The market repo: one folder per plugin in its root (Template/ first). */
export const marketDir = resolve(process.env.BOTHUB_MARKET_DIR ?? join(bothubRoot, '..', 'BothubMarketPlace'));
export const pluginsDir = marketDir;
/** Zips stay out of the market repo; they go to GitHub Releases (see README). */
export const distDir = join(root, 'dist');
/** The template is copied by authors, never packed or listed. */
export const TEMPLATE = 'Template';

// Limits of the BotHub install (api/src/Internal/PluginStore.php).
export const LIMITS = { files: 200, fileBytes: 2 << 20, zipBytes: 5 << 20, unpackedBytes: 20 << 20 };
// Development files that never go into the zip.
const SKIP = new Set(['node_modules', 'test', 'package.json', 'package-lock.json', 'dist']);

/** IDs of all plugin folders, or the ones named on the command line. */
export async function pluginIds(argv = []) {
  const all = (await readdir(pluginsDir, { withFileTypes: true }))
    .filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules')
    .map((e) => e.name)
    .sort();
  const wanted = argv.filter((a) => !a.startsWith('--'));
  for (const id of wanted) if (!all.includes(id)) throw new Error(`no plugin "${id}" in ${pluginsDir}`);
  return wanted.length ? wanted : all;
}

export const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'));

/** Files that go into the zip, as [absolute path, zip name], sorted. */
export async function packFiles(dir) {
  const out = [];
  const walk = async (d) => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      if (e.name.startsWith('.') || (d === dir && SKIP.has(e.name)) || e.name.endsWith('.zip')) continue;
      const p = join(d, e.name);
      if (e.isSymbolicLink()) throw new Error(`symlinks are not allowed: ${relative(dir, p)}`);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile()) out.push([p, relative(dir, p).split(sep).join('/')]);
    }
  };
  await walk(dir);
  return out.sort((a, b) => (a[1] < b[1] ? -1 : 1));
}

/**
 * Writes a zip (deflate, UTF-8 names, fixed dates, so the same files always
 * give the same bytes and SHA-256).
 */
export async function zip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  let unpacked = 0;
  for (const [path, nameText] of entries) {
    const size = (await stat(path)).size;
    if (size > LIMITS.fileBytes) throw new Error(`${nameText} is larger than 2 MB`);
    unpacked += size;
    if (unpacked > LIMITS.unpackedBytes) throw new Error('more than 20 MB unpacked');
    const data = await readFile(path);
    const packed = deflateRawSync(data, { level: 9 });
    const name = Buffer.from(nameText, 'utf8');
    const crc = crc32(data);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(0x0800, 6); // UTF-8 names
    head.writeUInt16LE(8, 8); // deflate
    head.writeUInt32LE(0x00210000, 10); // 1980-01-01 00:00
    head.writeUInt32LE(crc, 14);
    head.writeUInt32LE(packed.length, 18);
    head.writeUInt32LE(data.length, 22);
    head.writeUInt16LE(name.length, 26);
    locals.push(head, name, packed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(0x00210000, 12);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += head.length + name.length + packed.length;
  }
  const dir = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, end]);
}

/**
 * Copies the SDK test kit (BotHub sdk/dist, build it with: cd sdk && npx tsc)
 * into <plugin>/test/lib/, where the plugin's "#sdk-testing" import points.
 * test/ never goes into the zip.
 */
export async function installTestKit(dir) {
  const { copyFile, mkdir, readFile, writeFile } = await import('node:fs/promises');
  const { existsSync } = await import('node:fs');
  const dist = join(bothubRoot, 'sdk', 'dist');
  if (!existsSync(join(dist, 'testing.js'))) throw new Error(`missing ${join(dist, 'testing.js')} (build the SDK: cd sdk && npx tsc)`);
  const lib = join(dir, 'test', 'lib');
  await mkdir(lib, { recursive: true });
  // testing.js imports only types from index.js; keep the file standalone.
  const testing = (await readFile(join(dist, 'testing.js'), 'utf8')).replace(/^import .*from '\.\/index\.js';\n/m, '');
  await writeFile(join(lib, 'sdk-testing.js'), `// Copied from BotHub sdk/dist/testing.js by sdk/market (npm run sync-sdk); do not edit.\n${testing}`);
  await copyFile(join(dist, 'testing.d.ts'), join(lib, 'sdk-testing.d.ts'));
  await copyFile(join(dist, 'index.d.ts'), join(lib, 'sdk.d.ts'));
}
