// bothub-plugin.json of an installed plugin, checked like
// shared/plugin-manifest.schema.json (no schema library in the bot).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { catalog, expandPermissions } from './catalog.js';
import { SdkError } from './errors.js';

/** A permission key of shared/sdk-permissions.json, e.g. "storage". */
export type Permission = string;

export interface PluginBlock {
  name: string;
  definition: Record<string, unknown>;
}

export interface Manifest {
  id: string;
  name: string;
  version: string;
  sdk: 1;
  main: string;
  permissions: Permission[];
  blocks: PluginBlock[];
  /** Discord events the plugin handles (bothub.json "events"). */
  events: string[];
  /** Timed tasks (bothub.json "services.tasks"). */
  tasks: { name: string; every?: string; cron?: string }[];
  /** Secrets read by name (bothub.json "services.secrets"; needs secrets.read). */
  secrets: string[];
  /** Hosts http.get/post/... (http.outbound) or http.secret with a fixed https URL (secrets.use) may reach (bothub.json "services.hosts"). */
  hosts: string[];
  /** Inbound webhooks (bothub.json "services.webhooks"; needs webhooks.inbound). */
  webhooks: string[];
}

/** Plugin IDs are plugin_<name> (user decision 2026-10-01). */
const ID = /^plugin_[a-z0-9_]{1,57}$/;
const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,6}$/;
const MAIN = /^[A-Za-z0-9_./-]{1,100}\.m?js$/;
const BLOCK = /^[a-z][a-z0-9_]{0,31}$/;
const EVENT = /^[a-zA-Z][a-zA-Z0-9.]{1,40}$/;
const ENDPOINT = /^[A-Z][A-Z0-9_]{1,39}$/;
/** A full host name with a dot, no wildcards, no IP addresses. */
const HOST = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;

export function parseManifest(raw: unknown): Manifest {
  const m = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const bad = (field: string): never => {
    throw new SdkError('sdk.manifest.invalid', { field });
  };
  if (typeof m.id !== 'string' || !ID.test(m.id)) bad('id');
  if (typeof m.name !== 'string' || !m.name || m.name.length > 60) bad('name');
  if (typeof m.version !== 'string' || !VERSION.test(m.version)) bad('version');
  if (m.sdk !== 1) bad('sdk');
  if (typeof m.main !== 'string' || !MAIN.test(m.main) || m.main.split('/').includes('..')) bad('main');
  // Old coarse keys (e.g. discord.members.manage) count as their finer replacements.
  const perms = expandPermissions(m.permissions);
  const known = catalog().permissionKeys;
  if (!Array.isArray(perms) || perms.length > 40 || !perms.every((p) => typeof p === 'string' && known.has(p)) || new Set(perms).size !== perms.length) bad('permissions');
  const blocks = m.blocks ?? [];
  if (!Array.isArray(blocks) || blocks.length > 50) bad('blocks');
  for (const b of blocks as unknown[]) {
    const o = (b && typeof b === 'object' ? b : {}) as Record<string, unknown>;
    if (typeof o.name !== 'string' || !BLOCK.test(o.name) || !o.definition || typeof o.definition !== 'object') bad('blocks');
  }
  const events = m.events ?? [];
  if (!Array.isArray(events) || events.length > 30 || !events.every((e) => typeof e === 'string' && EVENT.test(e))) bad('events');
  const tasks = m.tasks ?? [];
  if (!Array.isArray(tasks) || tasks.length > 20) bad('tasks');
  for (const t of tasks as unknown[]) {
    const o = (t && typeof t === 'object' ? t : {}) as Record<string, unknown>;
    const every = typeof o.every === 'string' && /^\d{1,6}[smhd]$/.test(o.every);
    const cron = typeof o.cron === 'string' && o.cron.trim().split(/\s+/).length === 5 && o.cron.length <= 100;
    if (typeof o.name !== 'string' || !BLOCK.test(o.name) || every === cron) bad('tasks');
  }
  // API endpoints are gone: secrets + ctx.http.secret replace them.
  if (m.endpoints !== undefined && !(Array.isArray(m.endpoints) && m.endpoints.length === 0)) bad('endpoints');
  const secrets = m.secrets ?? [];
  if (!Array.isArray(secrets) || secrets.length > 20 || !secrets.every((e) => typeof e === 'string' && ENDPOINT.test(e))) bad('secrets');
  if ((secrets as string[]).length && !(perms as string[]).some((p) => p === 'secrets.read' || p === 'secrets.use')) bad('secrets');
  const hosts = m.hosts ?? [];
  if (!Array.isArray(hosts) || hosts.length > 25 || !hosts.every((h) => typeof h === 'string' && HOST.test(h))) bad('hosts');
  if ((hosts as string[]).length && !(perms as string[]).some((p) => p === 'http.outbound' || p === 'secrets.use')) bad('hosts');
  const webhooks = m.webhooks ?? [];
  if (!Array.isArray(webhooks) || webhooks.length > 10 || !webhooks.every((w) => typeof w === 'string' && BLOCK.test(w))) bad('webhooks');
  if ((webhooks as string[]).length && !(perms as string[]).includes('webhooks.inbound')) bad('webhooks');
  return {
    id: m.id as string, name: m.name as string, version: m.version as string, sdk: 1, main: m.main as string,
    permissions: perms as Permission[], blocks: blocks as PluginBlock[],
    events: events as string[], tasks: tasks as Manifest['tasks'], secrets: secrets as string[], hosts: hosts as string[], webhooks: webhooks as string[],
  };
}

/** A JSON file inside the plugin folder (size-limited, no leaving the folder). */
function readJson(pluginDir: string, rel: string): unknown {
  if (!/^[A-Za-z0-9_./-]{1,120}$/.test(rel) || rel.split('/').includes('..')) throw new SdkError('sdk.manifest.invalid', { field: rel });
  const text = readFileSync(join(pluginDir, rel), 'utf8');
  if (text.length > 256 * 1024) throw new SdkError('sdk.manifest.invalid', { field: rel });
  return JSON.parse(text);
}

/**
 * bothub.json (shared/plugin-format.md) normalized to the manifest the
 * runtime works with: permissions = sdk.permissions, sdk = sdk.version,
 * tasks/endpoints from services, blocks = nodes[] with nodes/<name>.json.
 */
export function normalizeBothubJson(pluginDir: string, raw: unknown): Record<string, unknown> {
  const b = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const sdk = (b.sdk && typeof b.sdk === 'object' ? b.sdk : {}) as Record<string, unknown>;
  const services = (b.services && typeof b.services === 'object' ? b.services : {}) as Record<string, unknown>;
  const nodes = Array.isArray(b.nodes) ? b.nodes : [];
  if (nodes.length > 50) throw new SdkError('sdk.manifest.invalid', { field: 'nodes' });
  const blocks = nodes.map((name) => {
    if (typeof name !== 'string' || !BLOCK.test(name)) throw new SdkError('sdk.manifest.invalid', { field: 'nodes' });
    const def = readJson(pluginDir, `nodes/${name}.json`);
    if (!def || typeof def !== 'object' || Array.isArray(def)) throw new SdkError('sdk.manifest.invalid', { field: `nodes/${name}.json` });
    // "$schema" is for editors; "type" may only repeat the block's own type; "version" is not allowed.
    const { $schema: _schema, ...rest } = def as Record<string, unknown>;
    if ('version' in rest || (rest.type !== undefined && rest.type !== `plugin.${String(b.id)}.${name}`)) {
      throw new SdkError('sdk.manifest.invalid', { field: `nodes/${name}.json` });
    }
    return { name, definition: rest };
  });
  return {
    id: b.id, name: b.name, version: b.version, main: b.main,
    sdk: sdk.version, permissions: sdk.permissions ?? [],
    events: b.events ?? [], tasks: services.tasks ?? [], endpoints: services.endpoints, secrets: services.secrets ?? [], hosts: services.hosts ?? [], webhooks: services.webhooks ?? [], blocks,
  };
}

/** Reads bothub.json (or the older bothub-plugin.json) of an installed plugin. */
export function readManifest(pluginDir: string): Manifest {
  let raw: unknown;
  try {
    raw = normalizeBothubJson(pluginDir, readJson(pluginDir, 'bothub.json'));
  } catch (err) {
    if (err instanceof SdkError) throw err;
    try {
      raw = readJson(pluginDir, 'bothub-plugin.json');
    } catch {
      throw new SdkError('sdk.manifest.missing');
    }
  }
  return parseManifest(raw);
}

/** Node type of a plugin block in graphs: plugin.<id>.<name>. */
export const blockType = (pluginId: string, name: string): string => `plugin.${pluginId}.${name}`;
