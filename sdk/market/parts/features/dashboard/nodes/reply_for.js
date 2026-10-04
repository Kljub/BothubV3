// Node plugin.__ID__.reply_for: finds the reply configured on the settings
// page (dashboard/settings.json, list "replies") for a text. Port "none"
// when no trigger matches.
import { setting } from '../services/util.js';

/** @type {import('@bothub/sdk').BlockHandler} */
export default async function replyFor(ctx, { config }) {
  const text = String(config.text ?? '').toLowerCase();
  const replies = setting(ctx, 'replies', []);
  const hit = replies.find((r) => r.trigger && text.includes(String(r.trigger).toLowerCase()));
  if (!hit) return { port: 'none' };
  return { results: { '': String(hit.answer ?? '') } };
}
