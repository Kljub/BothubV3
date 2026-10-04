// Node plugin.__ID__.hello (definition: nodes/hello.json).
// A node handler gets
//   config: the node's settings in the builder, placeholders already filled
//   vars:   the run's variables ({user.id} -> vars['user.id'])
// and returns { port?, results? }. results[''] becomes {Var},
// results['.length'] becomes {Var.length} (Var = the node's "variable").
// Throwing ends the run on the error port with the message in {error}.

/** @type {import('@bothub/sdk').BlockHandler} */
export default async function hello(ctx, { config, vars }) {
  const name = String(config.name || vars['user.name'] || 'there').trim().slice(0, 100);
  const text = `Hello ${name}!`;
  return { results: { '': text, '.length': String(text.length) } };
}
