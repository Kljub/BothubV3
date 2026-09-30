// SDK capability catalog (shared/sdk-permissions.json): which call needs
// which permission, which calls are core (no permission) and which the
// manager answers today.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface PermissionEntry {
  key: string;
  risk: 'low' | 'medium' | 'high';
  calls: string[];
  implemented: string[];
}

export interface Catalog {
  sdkVersion: number;
  core: { calls: string[]; implemented: string[] };
  permissions: PermissionEntry[];
  limits: Record<string, number>;
}

export interface CatalogIndex {
  raw: Catalog;
  permissionKeys: Set<string>;
  /** call → permission key, or 'core' */
  callPermission: Map<string, string>;
  implemented: Set<string>;
}

let cached: CatalogIndex | undefined;

export function indexCatalog(raw: Catalog): CatalogIndex {
  const callPermission = new Map<string, string>();
  const implemented = new Set<string>(raw.core.implemented);
  for (const c of raw.core.calls) callPermission.set(c, 'core');
  for (const p of raw.permissions) {
    for (const c of p.calls) callPermission.set(c, p.key);
    for (const c of p.implemented) implemented.add(c);
  }
  return { raw, permissionKeys: new Set(raw.permissions.map((p) => p.key)), callPermission, implemented };
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
