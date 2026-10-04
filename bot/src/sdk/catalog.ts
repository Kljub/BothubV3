// SDK capability catalog (shared/sdk-permissions.json): which call needs
// which permission, which calls are core (no permission) and which the
// manager answers today.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface PermissionEntry {
  key: string;
  /** Main group on the SDK policies page (members, messages, …). */
  group?: string;
  risk: 'low' | 'medium' | 'high';
  calls: string[];
  implemented: string[];
  /** discord.events.*: the Discord events this permission lets a plugin handle. */
  events?: string[];
  /** BotHub module this permission is about (modules.<module>.*). */
  module?: string;
  /** "module": modules.<key>.read, shares the module.* calls of modules.read for one module. */
  scope?: string;
}

export interface Catalog {
  sdkVersion: number;
  core: { calls: string[]; implemented: string[] };
  permissions: PermissionEntry[];
  /** Old coarse key -> the finer keys that replaced it. */
  replaced?: Record<string, string[]>;
  limits: Record<string, number>;
}

export interface CatalogIndex {
  raw: Catalog;
  permissionKeys: Set<string>;
  /** call → permission key, or 'core' */
  callPermission: Map<string, string>;
  implemented: Set<string>;
  /** Old key -> new keys (manifests that name an old key get the new ones). */
  replaced: Map<string, string[]>;
  /** Discord event -> the discord.events.* permission it needs. */
  eventPermission: Map<string, string>;
}

let cached: CatalogIndex | undefined;

export function indexCatalog(raw: Catalog): CatalogIndex {
  const callPermission = new Map<string, string>();
  const implemented = new Set<string>(raw.core.implemented);
  for (const c of raw.core.calls) callPermission.set(c, 'core');
  const eventPermission = new Map<string, string>();
  for (const p of raw.permissions) {
    // Per-module entries share the module.* calls; those stay mapped to modules.read.
    if (p.scope !== 'module') for (const c of p.calls) if (c !== 'events.discord') callPermission.set(c, p.key);
    for (const c of p.implemented) implemented.add(c);
    for (const e of p.events ?? []) eventPermission.set(e, p.key);
  }
  return {
    raw, permissionKeys: new Set(raw.permissions.map((p) => p.key)), callPermission, implemented,
    replaced: new Map(Object.entries(raw.replaced ?? {})), eventPermission,
  };
}

/**
 * The permissions a manifest asks for, with old coarse keys replaced by the
 * finer ones (shared/sdk-permissions.json "replaced"); order kept, no duplicates.
 * Values that are not strings stay as they are, so validation still sees them.
 */
export function expandPermissions(list: unknown): unknown {
  if (!Array.isArray(list)) return list;
  const replaced = catalog().replaced;
  const out: unknown[] = [];
  for (const p of list) {
    for (const k of typeof p === 'string' ? (replaced.get(p) ?? [p]) : [p]) if (!out.includes(k)) out.push(k);
  }
  return out;
}

/** Reads the catalog once (SHARED_DIR, default /shared). */
export function catalog(): CatalogIndex {
  cached ??= indexCatalog(JSON.parse(readFileSync(join(process.env.SHARED_DIR || '/shared', 'sdk-permissions.json'), 'utf8')) as Catalog);
  return cached;
}

/** Tests and the bot start: use this file instead of SHARED_DIR. */
export function useCatalog(file: string): CatalogIndex {
  cached = indexCatalog(JSON.parse(readFileSync(file, 'utf8')) as Catalog);
  return cached;
}
