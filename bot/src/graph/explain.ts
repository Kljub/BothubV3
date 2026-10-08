// Plain-language reasons for failed blocks (shared/run-errors.json): what
// went wrong and how to fix it. Discord API errors are told apart by their
// code and, for "missing permissions", by the kind of block that failed
// (a role block needs the bot's role above the role, a message block a
// channel override, …).

export type RunErrorTexts = Record<string, { en?: { text: string; fix: string }; de?: { text: string; fix: string } } | string>;

export interface Hint {
  /** Key in run-errors.json; the dashboard shows it in its own language. */
  key: string;
  params: Record<string, string>;
  /** English text and fix (Discord messages, fallback). */
  text: string;
  fix: string;
}

/** Which "missing permissions" text fits a block type. */
export function permissionKind(type: string): string {
  if (/roles?\b|_role|role_/.test(type) && !/role_info|role_list/.test(type)) return 'roles';
  if (/\.(ban|unban|kick|timeout|warn|change_nickname|lockdown)$/.test(type)) return 'moderation';
  if (/voice|music|deafen|mute_member/.test(type)) return 'voice';
  if (/channel|thread|lock_channel|forum|invite/.test(type)) return 'channel';
  if (/message|reply|react|pin|publish|purge|poll|form|card|embed/.test(type)) return 'message';
  return '';
}

/** Key in run-errors.json for an error of a block. */
export function hintKey(type: string, key: string, params: Record<string, unknown>, texts: RunErrorTexts): string | null {
  const code = Number(params.code ?? (key === 'error.run.missing_permissions' ? 50013 : NaN));
  if (Number.isFinite(code) && code > 0) {
    const message = String(params.message ?? '').toLowerCase();
    let sub = '';
    if (code === 50013) sub = permissionKind(type);
    if (code === 50035) sub = /emoji/.test(message) ? 'emoji' : /length|fewer|characters/.test(message) ? 'length' : /url|scheme/.test(message) ? 'url' : '';
    if (sub && texts[`discord.${code}.${sub}`]) return `discord.${code}.${sub}`;
    if (texts[`discord.${code}`]) return `discord.${code}`;
    return key === 'error.run.discord' ? 'discord.0' : texts[key] ? key : null;
  }
  return texts[key] ? key : null;
}

function fill(text: string, params: Record<string, string>): string {
  return text.replace(/\{([a-z]+)\}/g, (whole, name: string) => params[name] ?? whole);
}

/** The reason of a failed block; null when there is no text for it (its own message is shown then). */
export function explain(type: string, key: string, raw: Record<string, unknown>, texts: RunErrorTexts): Hint | null {
  const k = hintKey(type, key, raw, texts);
  const entry = k ? texts[k] : undefined;
  if (!k || !entry || typeof entry === 'string' || !entry.en) return null;
  const params: Record<string, string> = {};
  for (const [name, v] of Object.entries(raw)) if (v !== undefined && v !== null && typeof v !== 'object') params[name] = String(v).slice(0, 300);
  return { key: k, params, text: fill(entry.en.text, params), fix: fill(entry.en.fix, params) };
}
