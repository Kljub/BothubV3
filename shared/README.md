# shared

Files read by all three services (dashboard, API, bot). One source, so the editor, the validator and the interpreter never drift apart.

| File | Purpose |
|---|---|
| `graph.schema.json` | Structure of a command graph (format version 1) |
| `node-definition.schema.json` | Structure of one builder node type |
| `graph-limits.json` | Interpreter and validator limits |
| `nodes/*.json` | Core node definitions. Modules and plugins add their own in the same format |
| `examples/*.graph.json` | Example graphs, also used as test fixtures |

## Graph rules (validated by the API on save)

The JSON Schema checks structure only. The API validator additionally checks:

1. Exactly one node of category `trigger`.
2. Every `type` exists in the node definitions available to the bot, and `typeVersion` is not newer than the definition.
3. Every edge points to existing nodes and ports: `from` is an output, `to` is an input.
4. Port types match. `flow` connects only to `flow`. `any` accepts every data type. `T` connects to `list<T>` as a single-item list.
5. A data input has at most one edge unless `multiple` is set.
6. Required data inputs are connected or have a config fallback.
7. No cycles. Repetition only through a `flow.loop` node, limited by `maxLoopIterations`.
8. `config` is valid against the definition's `config` schema.
9. Nodes that `require` plugin permissions only appear if the plugin is installed for the bot with those permissions granted.

## Versioning

- `schemaVersion` (graph format): the API migrates older graphs before saving or executing.
- `typeVersion` (per node): the node definition ships migrations from older versions.
