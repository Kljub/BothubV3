// Block "Twitch lookup" (action.twitch_lookup, /twitch-lookup): profile of a
// Twitch channel by login. Needs the Twitch app of the bot owner (Admin →
// API / Secrets → Integrations). The follower count needs a user token
// (Twitch rule): it comes from the channel signed in for Twitch Alerts, else
// it stays empty.

export interface TwitchProfile {
  id: string;
  login: string;
  name: string;
  avatar: string;
  description: string;
  created: number;
  /** partner, affiliate or "" */
  type: string;
  followers: number | null;
  live: boolean;
  game: string;
  title: string;
  language: string;
  lastStream: number | null;
  lastVideoTitle: string;
  lastVideoUrl: string;
}

type GetJson = (url: string, headers: Record<string, string>) => Promise<{ status: number; body: any } | null>;

/** Reads a channel: user, channel info, live stream, latest VOD and (with a user token) followers. Null: no such channel. */
export async function lookupTwitch(login: string, auth: { clientId: string; appToken: string; userToken: string | null }, get: GetJson): Promise<TwitchProfile | null> {
  const app = { 'Client-Id': auth.clientId, Authorization: `Bearer ${auth.appToken}` };
  const H = 'https://api.twitch.tv/helix';
  const u = (await get(`${H}/users?login=${encodeURIComponent(login)}`, app))?.body?.data?.[0];
  if (!u?.id) return null;
  const [channel, stream, video, followers] = await Promise.all([
    get(`${H}/channels?broadcaster_id=${u.id}`, app),
    get(`${H}/streams?user_id=${u.id}`, app),
    get(`${H}/videos?user_id=${u.id}&type=archive&first=1`, app),
    auth.userToken ? get(`${H}/channels/followers?broadcaster_id=${u.id}&first=1`, { 'Client-Id': auth.clientId, Authorization: `Bearer ${auth.userToken}` }) : Promise.resolve(null),
  ]);
  const c = channel?.body?.data?.[0] ?? {};
  const s = stream?.body?.data?.[0];
  const v = video?.body?.data?.[0];
  const when = (iso: unknown) => (typeof iso === 'string' && Date.parse(iso) ? Date.parse(iso) : null);
  return {
    id: String(u.id),
    login: String(u.login ?? login),
    name: String(u.display_name ?? u.login ?? login),
    avatar: String(u.profile_image_url ?? ''),
    description: String(u.description ?? ''),
    created: when(u.created_at) ?? 0,
    type: String(u.broadcaster_type ?? ''),
    followers: followers?.status === 200 && Number.isFinite(Number(followers.body?.total)) ? Number(followers.body.total) : null,
    live: !!s,
    game: String(s?.game_name || c.game_name || ''),
    title: String(s?.title || c.title || ''),
    // The language of the latest stream (VOD), else the channel's setting.
    language: String(v?.language || c.broadcaster_language || ''),
    lastStream: s ? Date.now() : when(v?.created_at),
    lastVideoTitle: String(v?.title ?? ''),
    lastVideoUrl: String(v?.url ?? ''),
  };
}

const LANGS: Record<string, string> = {
  de: 'Deutsch', en: 'English', fr: 'Français', es: 'Español', it: 'Italiano', pt: 'Português', nl: 'Nederlands', pl: 'Polski', ru: 'Русский', tr: 'Türkçe',
  ja: '日本語', ko: '한국어', zh: '中文', sv: 'Svenska', da: 'Dansk', no: 'Norsk', fi: 'Suomi', cs: 'Čeština', uk: 'Українська', ar: 'العربية', other: 'Other',
};

/**
 * Named variables of a Twitch user ({twitch_name}, {twitch_follower} …),
 * the same in the lookup block and in Twitch Alerts. extra: what the event
 * adds (sub tier, bits).
 */
export function twitchVars(p: TwitchProfile, extra: { sub?: string; bits?: string } = {}): Record<string, string> {
  const r = lookupResults(p);
  return {
    twitch_name: p.name,
    twitch_link: String(r['.url']),
    twitch_follower: String(r['.followers']),
    twitch_sub: extra.sub ?? String(r['.subs']),
    twitch_bits: extra.bits ?? '—',
    twitch_since: String(r['.created']),
    twitch_last_stream: String(r['.last_stream']),
    twitch_language: String(r['.language']),
    twitch_is_affiliate: String(r['.affiliate']),
  };
}

/** Block results: "{Var.followers}", "{Var.affiliate}" (✅/❌) … */
export function lookupResults(p: TwitchProfile): Record<string, string | number> {
  const ts = (ms: number | null, style: string) => (ms ? `<t:${Math.floor(ms / 1000)}:${style}>` : '—');
  const yes = (b: boolean) => (b ? '✅' : '❌');
  const partner = p.type === 'partner';
  const affiliate = p.type === 'affiliate' || partner;
  return {
    '': p.name,
    '.login': p.login,
    '.id': p.id,
    '.url': `https://twitch.tv/${p.login}`,
    '.avatar': p.avatar,
    '.description': p.description.slice(0, 300) || '—',
    '.created': ts(p.created, 'D'),
    '.followers': p.followers === null ? '—' : p.followers.toLocaleString('en-US'),
    '.affiliate': yes(affiliate),
    '.partner': yes(partner),
    '.subs': yes(affiliate),
    '.live': p.live ? '🔴 Live' : '⚫ Offline',
    '.last_stream': p.live ? '🔴 Live' : ts(p.lastStream, 'R'),
    '.game': p.game || '—',
    '.title': p.title || '—',
    '.language': p.language ? `${LANGS[p.language] ?? p.language.toUpperCase()}` : '—',
    '.last_video': p.lastVideoTitle ? `[${p.lastVideoTitle.slice(0, 80)}](${p.lastVideoUrl})` : '—',
  };
}
