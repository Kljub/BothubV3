// Node plugin.__ID__.api_get: GET <address><path>?<query>, optionally one
// field of the JSON answer. Port "failed" on HTTP errors (status >= 400),
// "not_set_up" while a secret has no value (result .missing: the names).
import { get, NotSetUp, parseQuery, pick } from '../services/api.js';

/** @type {import('@bothub/sdk').BlockHandler} */
export default async function apiGet(ctx, { config }) {
  let res;
  try {
    res = await get(ctx, String(config.path || '/'), parseQuery(config.query));
  } catch (err) {
    if (err instanceof NotSetUp) return { port: 'not_set_up', results: { '.missing': err.missing.join(', ') } };
    throw err;
  }
  const status = String(res.status);
  if (res.status >= 400) return { port: 'failed', results: { '.status': status } };
  const value = res.json === null ? res.text : pick(res.json, config.field);
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? null);
  return { results: { '': text.slice(0, 4000), '.status': status } };
}
