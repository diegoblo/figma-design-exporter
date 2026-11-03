export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonRecord = { [key: string]: JsonValue };

export interface ExportOptions {
  scope: 'selection' | 'page';
  includeHidden: boolean;
  includeInstanceChildren: boolean;
  includeComponentChildren: boolean;
  includeComponents: boolean;
  compact: boolean;
}

export interface ExportError {
  nodeId?: string;
  phase: string;
  message: string;
}

export interface ExportDocument {
  schemaVersion: '1.0.0';
  document: {
    name: string;
    page: { id: string; name: string };
    exportedAt: string;
    scope: 'selection' | 'page';
    childOrder: 'back-to-front';
  };
  roots: string[];
  nodes: Record<string, JsonRecord>;
  components: Record<string, JsonRecord>;
  styles: {
    paints: Record<string, JsonValue>;
    effects: Record<string, JsonValue>;
    text: Record<string, JsonValue>;
    local: Record<string, JsonRecord>;
  };
  tokens: {
    collections: Record<string, JsonRecord>;
    variables: Record<string, JsonRecord>;
  };
  stats: {
    nodeCount: number;
    hiddenNodesOmitted: number;
    childRootsOmittedByOptions: number;
    estimatedBytes: number;
    errors: ExportError[];
  };
  limitations: string[];
}

export interface ExportSnapshot {
  signature: string;
  json: string;
  nodeCount: number;
  bytes: number;
  errors: number;
}

