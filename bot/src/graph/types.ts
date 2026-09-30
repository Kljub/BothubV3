// Graph format: shared/graph.schema.json (version 1).

export interface GraphNode {
  id: string;
  type: string;
  typeVersion: number;
  config: Record<string, unknown>;
  position?: { x: number; y: number };
  label?: string;
  note?: string;
  /** Flow output "next" becomes "success" and "error". */
  paths?: boolean;
  /** Skipped; the flow continues at its "next". */
  disabled?: boolean;
}

export interface Endpoint {
  node: string;
  port: string;
}

export interface Edge {
  from: Endpoint;
  to: Endpoint;
}

export interface Graph {
  schemaVersion: 1;
  nodes: GraphNode[];
  edges: Edge[];
}

/** Subset of shared/nodes/*.json the bot needs at run time. */
export interface NodeDefinition {
  type: string;
  category: 'trigger' | 'option' | 'action' | 'condition' | 'component' | 'utility';
  conditionKind?: 'compare' | 'chance' | 'match' | 'option';
  compact?: boolean;
  config?: { properties?: Record<string, { default?: unknown }> };
}

export function isGraph(value: unknown): value is Graph {
  const g = value as Graph | null;
  return !!g && g.schemaVersion === 1 && Array.isArray(g.nodes) && Array.isArray(g.edges);
}
