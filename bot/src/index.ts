// Phase 0 skeleton: the process starts and stays alive. The bot manager,
// stream consumer and graph interpreter follow in phase 3 (see plan.md).

console.log(
  JSON.stringify({ msg: 'bot process started', dataDir: process.env.DATA_DIR }),
);

const keepAlive = setInterval(() => {}, 60_000);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    clearInterval(keepAlive);
    console.log(JSON.stringify({ msg: 'bot process stopping', signal }));
    process.exit(0);
  });
}
