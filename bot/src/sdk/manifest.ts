// bothub-plugin.json of an installed plugin, checked like
// shared/plugin-manifest.schema.json (no schema library in the bot).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { catalog } from './catalog.js';
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
}

const ID = /^[a-z0-9][a-z0-9-]{1,63}$/;
const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,6}$/;
const MAIN = /^[A-Za-z0-9_./-]{1,100}\.m?js$/;
const BLOCK = /^[a-z][a-z0-9_]{0,31}$/;

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
  const perms = m.permissions;
  const known = catalog().permissionKeys;
  if (!Array.isArray(perms) || perms.length > 40 || !perms.every((p) => typeof p === 'string' && known.has(p)) || new Set(perms).size !== perms.length) bad('permissions');
  const blocks = m.blocks ?? [];
  if (!Array.isArray(blocks) || blocks.length > 50) bad('blocks');
  for (const b of blocks as unknown[]) {
    const o = (b && typeof b === 'object' ? b : {}) as Record<string, unknown>;
    if (typeof o.name !== 'string' || !BLOCK.test(o.name) || !o.definition || typeof o.definition !== 'object') bad('blocks');
  }
  return { id: m.id as string, name: m.name as string, version: m.version as string, sdk: 1, main: m.main as string, permissions: perms as Permission[], blocks: blocks as PluginBlock[] };
}

export function readManifest(pluginDir: string): Manifest {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(pluginDir, 'bothub-plugin.json'), 'utf8'));
  } catch {
    throw new SdkError('sdk.manifest.missing');
  }
  return parseManifest(raw);
}

/** Node type of a plugin block in graphs: plugin.<id>.<name>. */
export const blockType = (pluginId: string, name: string): string => `plugin.${pluginId}.${name}`;
