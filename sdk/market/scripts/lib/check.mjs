// Reads a plugin folder (bothub.json + the layer files it names), turns it
// into the normalized manifest the BotHub API and bot use, and checks it
// like the install does, plus what only shows at runtime (handlers, texts).
// Format: BotHub shared/plugin-format.md.
import { readdir, readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import { bothubRoot, LIMITS, packFiles, readJson, TEMPLATE } from './plugins.mjs';

const schema = await readJson(join(bothubRoot, 'shared', 'plugin-manifest.schema.json'));
const catalog = await readJson(join(bothubRoot, 'shared', 'sdk-permissions.json'));
const ajv = new Ajv2020({ allErrors: true, strict: false });
ajv.addSchema(schema);
const validateBothub = ajv.getSchema(schema.$id);
const validateSettings = ajv.getSchema(`${schema.$id}#/$defs/settingsFile`);
const validateNode = ajv.getSchema(`${schema.$id}#/$defs/nodeFile`);
const knownPermissions = new Set(catalog.permissions.map((p) => p.key));
// Old coarse keys -> finer ones ("replaced"); Discord event -> its discord.events.* permission.
const replaced = catalog.replaced ?? {};
const eventPermission = new Map(catalog.permissions.flatMap((p) => (p.events ?? []).map((e) => [e, p.key])));
const expand = (list) => [...new Set(list.flatMap((p) => replaced[p] ?? [p]))];
// A part of bothub.json only works with its SDK permission.
const NEEDS = { webhooks: 'webhooks.inbound', tasks: 'scheduler' };
const SOUND = /^[a-z0-9_-]{1,64}\.(ogg|mp3|wav)$/;

const schemaErrors = (validate, where) => (validate.errors ?? []).map((e) => `${where} ${e.instancePath || '/'} ${e.message}`);
const strip = (obj) => {
  const { $schema, ...rest } = obj; // eslint-disable-line no-unused-vars
  return rest;
};

/**
 * bothub.json + layer files -> normalized manifest (the object the BotHub
 * API stores as "manifest"). Errors of missing or broken files go to errors.
 */
export async function normalize(dir, errors = []) {
  const b = await readJson(join(dir, 'bothub.json'));
  const m = {
    id: b.id, name: b.name, version: b.version, description: b.description,
    author: b.developer?.name, developer: b.developer, ...(b.license ? { license: b.license } : {}), ...(b.icon ? { icon: b.icon } : {}), ...(b.category ? { category: b.category } : {}),
    sdk: b.sdk?.version, main: b.main, permissions: expand(b.sdk?.permissions ?? []),
    endpoints: b.services?.endpoints ?? [], secrets: b.services?.secrets ?? [], hosts: b.services?.hosts ?? [], webhooks: b.services?.webhooks ?? [], connect: b.services?.connect ?? {}, events: b.events ?? [], tasks: b.services?.tasks ?? [],
    commands: b.commands ?? [], blocks: [], ...(b.lang ? { lang: b.lang } : {}),
  };
  for (const name of b.nodes ?? []) {
    const file = join(dir, 'nodes', `${name}.json`);
    if (!existsSync(file)) { errors.push(`missing nodes/${name}.json`); continue; }
    const definition = await readJson(file);
    if (!validateNode(definition)) errors.push(...schemaErrors(validateNode, `nodes/${name}.json`));
    if (definition.type !== undefined && definition.type !== `plugin.${b.id}.${name}`) errors.push(`nodes/${name}.json: type must be plugin.${b.id}.${name}`);
    m.blocks.push({ name, definition: strip(definition) });
  }
  if (b.dashboard?.settings) {
    const file = join(dir, b.dashboard.settings);
    if (!existsSync(file)) errors.push(`missing ${b.dashboard.settings}`);
    else {
      const settings = await readJson(file);
      if (!validateSettings(settings)) errors.push(...schemaErrors(validateSettings, b.dashboard.settings));
      m.settings = strip(settings);
    }
  }
  return { bothub: b, manifest: m };
}

/** JavaScript files of a plugin folder (tests and node_modules left out). */
async function jsFiles(dir, sub = '') {
  const out = [];
  for (const e of await readdir(join(dir, sub), { withFileTypes: true })) {
    const rel = sub ? `${sub}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (!['node_modules', 'test', 'tests', '.git'].includes(e.name)) out.push(...(await jsFiles(dir, rel)));
    } else if (/\.m?js$/.test(e.name)) out.push(rel);
  }
  return out;
}

/**
 * Every ctx.secrets.get/has in the code must name its secret as fixed text
 * that bothub.json "services.secrets" declares, so the App Store can list
 * exactly what the plugin reads. A name built at runtime is refused.
 */
export async function secretUses(dir, declared) {
  const problems = [];
  for (const file of await jsFiles(dir)) {
    const code = await readFile(join(dir, file), 'utf8');
    for (const call of code.matchAll(/\bsecrets\s*\.\s*(get|has)\s*\(\s*([^)]*)\)/g)) {
      const arg = call[2].trim();
      const lit = /^(['"`])([A-Z][A-Z0-9_]{1,39})\1$/.exec(arg);
      if (!lit || (lit[1] === '`' && arg.includes('${'))) {
        problems.push(`${file}: secrets.${call[1]}(${arg.slice(0, 40)}) must name the secret as fixed text, e.g. secrets.${call[1]}('WEATHER_API_KEY')`);
      } else if (!declared.includes(lit[2])) {
        problems.push(`${file}: secret ${lit[2]} is used but not declared in bothub.json "services.secrets"`);
      }
    }
  }
  return problems;
}

/** All problems of one plugin folder; [] when it is fine. */
export async function check(dir) {
  const errors = [];
  const err = (text) => errors.push(text);
  // Template/ is the only folder not named like its id (plugin_template).
  const folder = basename(dir.replace(/[\\/]+$/, ''));
  const id = folder === TEMPLATE ? 'plugin_template' : folder;
  if (!existsSync(join(dir, 'bothub.json'))) return ['missing bothub.json'];
  const { bothub, manifest: m } = await normalize(dir, errors);

  if (!validateBothub(bothub)) errors.push(...schemaErrors(validateBothub, 'bothub.json'));
  if (m.id !== id) err(`bothub.json id "${m.id}" must equal the folder name "${id}"`);
  for (const p of m.permissions) if (!knownPermissions.has(p)) err(`unknown SDK permission "${p}"`);
  for (const [field, perm] of Object.entries(NEEDS)) {
    if (m[field].length && !m.permissions.includes(perm)) err(`"${field}" needs the SDK permission ${perm}`);
  }
  // Hosts: for http.get/post/... (http.outbound) or fixed https URLs of ctx.http.secret (secrets.use).
  if (m.hosts.length && !m.permissions.some((p) => p === 'http.outbound' || p === 'secrets.use')) err('"hosts" needs the SDK permission http.outbound or secrets.use');
  if (m.secrets.length && !m.permissions.some((p) => p === 'secrets.read' || p === 'secrets.use')) err('"secrets" needs the SDK permission secrets.use (requests) or secrets.read (values)');
  // Image settings fields keep their uploads in the plugin files.
  const hasImage = (fields) => (fields ?? []).some((f) => f.type === 'image' || (f.type === 'list' && hasImage(f.item)));
  if (hasImage(m.settings?.fields) && !m.permissions.includes('storage.files')) err('image settings fields need the SDK permission storage.files');
  if (m.endpoints.length) err('"services.endpoints" is gone: declare the address and the key in "services.secrets" and use ctx.http.secret');
  for (const e of m.events) {
    const need = eventPermission.get(e);
    if (!need) err(`unknown Discord event "${e}"`);
    else if (!m.permissions.includes(need)) err(`event ${e} needs the SDK permission ${need}`);
  }
  if (!existsSync(join(dir, m.main ?? ''))) err(`main file ${m.main} is missing`);
  for (const problem of await secretUses(dir, m.secrets)) err(problem);

  // Layer folders hold only what bothub.json names.
  const listed = async (folder, ext, names) => {
    if (!existsSync(join(dir, folder))) return;
    for (const f of await readdir(join(dir, folder))) {
      if (f.endsWith(ext) && !names.includes(f.slice(0, -ext.length))) err(`${folder}/${f} is not named in bothub.json`);
    }
  };
  await listed('nodes', '.json', m.blocks.map((b) => b.name));
  await listed('events', '.js', m.events);
  await listed('commands', '.json', m.commands.map((c) => c.replace(/^commands\/|\.json$/g, '')));
  for (const b of m.blocks) if (!existsSync(join(dir, 'nodes', `${b.name}.js`))) err(`missing nodes/${b.name}.js (handler)`);
  for (const e of m.events) if (!existsSync(join(dir, 'events', `${e}.js`))) err(`missing events/${e}.js (handler)`);

  // Texts.
  const prefix = `plugin.${id}.`;
  const lang = {};
  for (const [code, path] of Object.entries(m.lang ?? {})) {
    const file = join(dir, path);
    if (!existsSync(file)) { err(`missing ${path}`); continue; }
    if ((await stat(file)).size > 64 * 1024) err(`${path} is larger than 64 KB`);
    lang[code] = await readJson(file);
    for (const [k, v] of Object.entries(lang[code])) {
      if (!k.startsWith(prefix)) err(`${path}: key ${k} must start with ${prefix}`);
      if (typeof v !== 'string' || v.length > 500) err(`${path}: ${k} must be text up to 500 characters`);
    }
  }
  const en = lang.en ?? {};
  for (const k of Object.keys(lang.de ?? {})) if (!(k in en)) err(`lang/de.json: ${k} is missing in en.json`);
  const label = (key, where) => { if (key && !en[key]) err(`missing English text ${key} (${where})`); };
  label(`${prefix}name`, 'name');
  for (const b of m.blocks) {
    label(b.definition.labelKey, `node ${b.name}`);
    label(b.definition.descriptionKey, `node ${b.name}`);
  }
  const walk = (fields, base) => {
    for (const f of fields) {
      label(base + f.key, `setting ${f.key}`);
      if (f.hint) label(`${base}${f.key}_hint`, `setting ${f.key}`);
      for (const o of f.options ?? []) label(`${base}${f.key}.${o}`, `setting ${f.key}`);
      if (f.type === 'list') walk(f.item ?? [], `${base}${f.key}.`);
    }
  };
  walk(m.settings?.fields ?? [], `${prefix}setting.`);

  // Commands: the install rules (PluginStore); the full graph check runs on install.
  const ownNodes = new Set(m.blocks.map((b) => `plugin.${id}.${b.name}`));
  for (const path of m.commands) {
    const file = join(dir, path);
    if (!existsSync(file)) { err(`missing ${path}`); continue; }
    const cmd = await readJson(file);
    if (typeof cmd.name !== 'string' || !/^[a-z0-9_-]{1,32}( [a-z0-9_-]{1,32}){0,2}$/.test(cmd.name)) err(`${path}: name must be 1-3 words of a-z 0-9 _ -`);
    if (String(cmd.description ?? '').length > 100) err(`${path}: description longer than 100 characters`);
    const nodes = cmd.graph?.nodes ?? [];
    if (nodes.filter((n) => n.type === 'trigger.slash').length !== 1) err(`${path}: needs exactly one trigger.slash block`);
    const ids = new Set(nodes.map((n) => n.id));
    for (const n of nodes) {
      if (n.type?.startsWith('plugin.') && !ownNodes.has(n.type)) err(`${path}: ${n.type} is not a node of this plugin`);
    }
    for (const e of cmd.graph?.edges ?? []) {
      if (!ids.has(e.from?.node) || !ids.has(e.to?.node)) err(`${path}: edge to an unknown node`);
    }
  }

  // Sounds.
  if (existsSync(join(dir, 'sounds'))) {
    for (const f of await readdir(join(dir, 'sounds'))) {
      if (!SOUND.test(f)) err(`sounds/${f}: name must match [a-z0-9_-].ogg|mp3|wav`);
      if ((await stat(join(dir, 'sounds', f))).size > LIMITS.fileBytes) err(`sounds/${f} is larger than 2 MB`);
    }
    if (!m.permissions.includes('discord.voice.speak')) err('sounds/ needs the SDK permission discord.voice.speak');
  }

  // Code: main joins every handler bothub.json names.
  try {
    const plugin = (await import(pathToFileURL(join(dir, m.main)).href)).default;
    for (const b of m.blocks) if (typeof plugin?.blocks?.[b.name] !== 'function') err(`${m.main} does not export node handler blocks.${b.name}`);
    for (const e of m.events) if (typeof plugin?.events?.[e] !== 'function') err(`${m.main} does not export event handler events.${e}`);
    for (const t of m.tasks) if (typeof plugin?.tasks?.[t.name] !== 'function') err(`${m.main} does not export task tasks.${t.name}`);
  } catch (e) {
    err(`cannot load ${m.main}: ${e.message}`);
  }

  const files = await packFiles(dir);
  if (files.length > LIMITS.files) err(`more than ${LIMITS.files} files`);
  let unpacked = 0;
  for (const [path] of files) unpacked += (await stat(path)).size;
  if (unpacked > LIMITS.unpackedBytes) err('more than 20 MB unpacked');
  return errors;
}
