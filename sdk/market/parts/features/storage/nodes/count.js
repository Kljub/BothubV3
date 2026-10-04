// Node plugin.__ID__.count: counts per server; {Var.user} counts per member.

/** @type {import('@bothub/sdk').BlockHandler} */
export default async function count(ctx, { config, vars }) {
  const server = vars['server.id'] || 'dm';
  const counter = String(config.counter || 'default');
  const step = Number.isInteger(config.step) ? config.step : 1;
  const total = await ctx.storage.increment(`count:${server}:${counter}`, step);
  const user = vars['user.id'] ? await ctx.storage.increment(`count:${server}:${counter}:${vars['user.id']}`, step) : 0;
  return { results: { '': String(total), '.user': String(user) } };
}
