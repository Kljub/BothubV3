// Node plugin.__ID__.stop_sound: stops playing; leaves unless "stay connected".
import { stop } from '../services/voice.js';

/** @type {import('@bothub/sdk').BlockHandler} */
export default async function stopSound(ctx, { vars }) {
  if (vars['server.id']) await stop(ctx, vars['server.id']);
}
