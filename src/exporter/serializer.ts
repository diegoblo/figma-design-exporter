import type { ExportDocument, ExportOptions, ExportSnapshot, JsonRecord, JsonValue } from './schema.ts';
import { canonicalJson, isRecord, toJsonValue, utf8ByteLength } from './normalize.ts';

const NODE_BATCH_SIZE = 160;
const LOOKUP_BATCH_SIZE = 32;
const MAX_ERRORS = 500;

const GEOMETRY_FIELDS = [
  'x', 'y', 'width', 'height', 'rotation', 'relativeTransform', 'absoluteTransform',
  'absoluteBoundingBox', 'absoluteRenderBounds', 'constraints', 'targetAspectRatio',
  'preserveRatio', 'layoutSizingHorizontal', 'layoutSizingVertical', 'layoutAlign',
  'layoutGrow', 'layoutPositioning', 'minWidth', 'maxWidth', 'minHeight', 'maxHeight'
] as const;

const LAYOUT_FIELDS = [
  'layoutMode', 'primaryAxisSizingMode', 'counterAxisSizingMode', 'primaryAxisAlignItems',
  'counterAxisAlignItems', 'counterAxisAlignContent', 'layoutWrap', 'itemSpacing',
  'counterAxisSpacing', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
  'strokesIncludedInLayout', 'itemReverseZIndex'
] as const;

const APPEARANCE_FIELDS = [
  'opacity', 'blendMode', 'isMask', 'maskType', 'clipsContent', 'overflowDirection',
  'cornerRadius', 'topLeftRadius', 'topRightRadius', 'bottomLeftRadius', 'bottomRightRadius',
  'cornerSmoothing', 'strokeWeight', 'strokeTopWeight', 'strokeRightWeight', 'strokeBottomWeight',
  'strokeLeftWeight', 'strokeAlign', 'strokeCap', 'strokeJoin', 'strokeMiterLimit', 'strokeDashes',
  'individualStrokeWeights', 'fillsGeometry', 'strokesGeometry', 'layoutGrids', 'boundVariables'
] as const;

const TEXT_FIELDS = [
  'textAutoResize', 'textTruncation', 'textAlignHorizontal', 'textAlignVertical', 'textCase',
  'textDecoration', 'textDecorationStyle', 'textDecorationOffset', 'textDecorationThickness',
  'textDecorationColor', 'textDecorationSkipInk', 'fontName', 'fontSize', 'fontWeight', 'fontStyle',
  'lineHeight', 'letterSpacing', 'paragraphIndent', 'paragraphSpacing', 'listSpacing', 'indentation',
  'listOptions', 'openTypeFeatures', 'hyperlink', 'boundVariables', 'textStyleOverrides'
] as const;

const STYLE_ID_FIELDS = [
  ['fillStyleId', 'fills'],
  ['strokeStyleId', 'strokes'],
  ['effectStyleId', 'effects'],
  ['textStyleId', 'text'],
  ['gridStyleId', 'layoutGrids'],
  ['backgroundStyleId', 'backgrounds']
] as const;

const TEXT_SEGMENT_FIELDS = [
  'fontSize', 'fontName', 'fontWeight', 'fontStyle', 'textDecoration', 'textDecorationStyle',
  'textDecorationOffset', 'textDecorationThickness', 'textDecorationColor', 'textDecorationSkipInk',
  'textCase', 'lineHeight', 'letterSpacing', 'fills', 'textStyleId', 'fillStyleId', 'listOptions',
  'listSpacing', 'indentation', 'paragraphIndent', 'paragraphSpacing', 'hyperlink', 'boundVariables',
  'textStyleOverrides', 'openTypeFeatures'
] as const;

const LIMITATIONS = [
  'Only properties exposed by the Figma Plugin API are exported. A missing property means the API did not expose a value for that node; no value is inferred.',
  'The API does not generally label a property as explicit, inherited, or computed. Instance overrides are included where Figma exposes them; bounding boxes and absolute transforms are the API-provided geometry results.',
  'Image and video payloads are not embedded. Paint metadata and image hashes are retained, but the JSON does not contain the media bytes.',
  'Components outside the selected tree are represented by definition metadata and references. Their full layer trees are exported only when they are inside the chosen scope.',
  'Text-run indexes use JavaScript UTF-16 offsets, matching the Figma Plugin API.'
];

type UnknownRecord = Record<string, unknown>;
type SceneNodeLike = SceneNode;

interface ReadResult {
  available: boolean;
  value?: unknown;
  error?: unknown;
}

interface TraversalTask {
  node: SceneNodeLike;
  underHiddenAncestor: boolean;
}

interface PendingComponent {
  nodeId: string;
  node: SceneNodeLike;
}

export interface SerializeInput {
  figma: PluginAPI;
  page: PageNode;
  roots: readonly SceneNodeLike[];
  options: ExportOptions;
  onProgress?: (stage: string, completed: number, total: number) => void;
}

function asRecord(value: unknown): UnknownRecord | undefined {
  return isRecord(value) ? value : undefined;
}

function read(target: unknown, field: string): ReadResult {
  try {
    const object = asRecord(target);
    if (!object) return { available: false };
    const value = object[field];
    return { available: value !== undefined || field in object, value };
  } catch (error) {
    return { available: false, error };
  }
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 360 ? `${message.slice(0, 357)}...` : message;
}

function stableId(prefix: string, index: number): string {
  return `${prefix}${String(index).padStart(4, '0')}`;
}

function getNodeChildren(node: SceneNodeLike): SceneNodeLike[] {
  const result = read(node, 'children');
  return result.available && Array.isArray(result.value) ? result.value as SceneNodeLike[] : [];
}

function internValue(
  value: unknown,
  prefix: string,
  pool: Record<string, JsonValue>,
  reverse: Map<string, string>,
  mixedSentinel: unknown
): string {
  const jsonValue = toJsonValue(value, mixedSentinel) ?? null;
  const canonical = canonicalJson(jsonValue);
  const existing = reverse.get(canonical);
  if (existing) return existing;
  const id = stableId(prefix, Object.keys(pool).length + 1);
  pool[id] = jsonValue;
  reverse.set(canonical, id);
  return id;
}

function collectAliasIds(value: unknown, output: Set<string>, seen = new WeakSet<object>()): void {
  if (!value || typeof value !== 'object') return;
  if (seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) collectAliasIds(item, output, seen);
    return;
  }
  const record = value as UnknownRecord;
  if (record.type === 'VARIABLE_ALIAS' && typeof record.id === 'string') output.add(record.id);
  for (const field of Object.values(record)) collectAliasIds(field, output, seen);
}

function pickFields(
  source: unknown,
  fields: readonly string[],
  mixedSentinel: unknown,
  errors: ExportDocument['stats']['errors'],
  nodeId?: string,
  phase = 'read-property'
): JsonRecord {
  const output: JsonRecord = {};
  for (const field of fields) {
    const result = read(source, field);
    if (result.error) addError(errors, nodeId, phase, `${field}: ${errorMessage(result.error)}`);
    if (!result.available) continue;
    const json = toJsonValue(result.value, mixedSentinel);
    if (json !== undefined) output[field] = json;
  }
  return output;
}

function addError(
  errors: ExportDocument['stats']['errors'],
  nodeId: string | undefined,
  phase: string,
  error: unknown
): void {
  if (errors.length >= MAX_ERRORS) return;
  errors.push({ nodeId, phase, message: errorMessage(error) });
}

function addNonEmpty(target: JsonRecord, key: string, value: JsonRecord): void {
  if (Object.keys(value).length > 0) target[key] = value;
}

function collectStyleIds(value: unknown, ids: Set<string>, seen = new WeakSet<object>()): void {
  if (!value || typeof value !== 'object') return;
  if (seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) collectStyleIds(item, ids, seen);
    return;
  }
  for (const [key, fieldValue] of Object.entries(value as UnknownRecord)) {
    if (key.endsWith('StyleId') && typeof fieldValue === 'string' && fieldValue.length > 0) ids.add(fieldValue);
    collectStyleIds(fieldValue, ids, seen);
  }
}

function exportPaintGroup(
  node: SceneNodeLike,
  field: 'fills' | 'strokes' | 'effects',
  prefix: string,
  pool: Record<string, JsonValue>,
  reverse: Map<string, string>,
  mixedSentinel: unknown,
  errors: ExportDocument['stats']['errors'],
  nodeId: string
): string | JsonValue | undefined {
  const result = read(node, field);
  if (result.error) addError(errors, nodeId, 'read-appearance', `${field}: ${errorMessage(result.error)}`);
  if (!result.available) return undefined;
  if (result.value === mixedSentinel) return { mixed: true };
  if (!Array.isArray(result.value)) return toJsonValue(result.value, mixedSentinel);
  return internValue(result.value, prefix, pool, reverse, mixedSentinel);
}

function componentDefinitionRecord(node: SceneNodeLike, mixedSentinel: unknown): JsonRecord {
  const id = String(read(node, 'id').value ?? '');
  const record: JsonRecord = { id };
  for (const field of ['name', 'key', 'description', 'type', 'componentPropertyDefinitions'] as const) {
    const result = read(node, field);
    if (result.available) {
      const json = toJsonValue(result.value, mixedSentinel);
      if (json !== undefined) record[field] = json;
    }
  }
  const parent = read(node, 'parent').value;
  const parentType = read(parent, 'type').value;
  if (parentType === 'COMPONENT_SET') {
    record.componentSetId = String(read(parent, 'id').value ?? '');
    record.componentSetName = String(read(parent, 'name').value ?? '');
  }
  return record;
}

function registerComponent(
  component: SceneNodeLike,
  components: Record<string, JsonRecord>,
  mixedSentinel: unknown
): void {
  const idValue = read(component, 'id').value;
  if (typeof idValue !== 'string' || idValue.length === 0) return;
  components[idValue] ??= componentDefinitionRecord(component, mixedSentinel);
}

function pushComponentReference(
  target: JsonRecord,
  component: SceneNodeLike,
  components: Record<string, JsonRecord>,
  includeComponents: boolean,
  mixedSentinel: unknown
): void {
  const id = read(component, 'id').value;
  if (typeof id !== 'string') return;
  const reference: JsonRecord = { id };
  for (const field of ['name', 'key'] as const) {
    const value = read(component, field);
    if (value.available) {
      const json = toJsonValue(value.value, mixedSentinel);
      if (json !== undefined) reference[field] = json;
    }
  }
  target.componentRef = reference;
  if (includeComponents) registerComponent(component, components, mixedSentinel);
}

async function buildStyles(
  figmaApi: PluginAPI,
  ids: Set<string>,
  pools: ExportDocument['styles'],
  paintReverse: Map<string, string>,
  effectReverse: Map<string, string>,
  mixedSentinel: unknown,
  errors: ExportDocument['stats']['errors'],
  onProgress?: SerializeInput['onProgress']
): Promise<void> {
  const sortedIds = [...ids].sort();
  for (let offset = 0; offset < sortedIds.length; offset += LOOKUP_BATCH_SIZE) {
    const batch = sortedIds.slice(offset, offset + LOOKUP_BATCH_SIZE);
    const results = await Promise.allSettled(batch.map((id) => figmaApi.getStyleByIdAsync(id)));
    for (let index = 0; index < batch.length; index += 1) {
      const id = batch[index];
      const result = results[index];
      if (!id || !result) continue;
      if (result.status === 'rejected') {
        addError(errors, undefined, 'read-style', `${id}: ${errorMessage(result.reason)}`);
        continue;
      }
      const style = result.value;
      if (!style) continue;
      const styleType = String(read(style, 'type').value ?? 'UNKNOWN');
      const record: JsonRecord = { id };
      const metadata = pickFields(style, ['name', 'description', 'key', 'remote', 'type'], mixedSentinel, errors, undefined, 'read-style');
      Object.assign(record, metadata);
      if (styleType === 'PAINT') {
        const paints = read(style, 'paints');
        if (paints.available && Array.isArray(paints.value)) {
          record.paintRef = internValue(paints.value, 'P', pools.paints, paintReverse, mixedSentinel);
        }
      } else if (styleType === 'EFFECT') {
        const effects = read(style, 'effects');
        if (effects.available && Array.isArray(effects.value)) {
          record.effectRef = internValue(effects.value, 'E', pools.effects, effectReverse, mixedSentinel);
        }
      } else if (styleType === 'TEXT') {
        const values = pickFields(style, [...TEXT_FIELDS, 'textAlignHorizontal', 'textAlignVertical', 'textAutoResize'], mixedSentinel, errors, undefined, 'read-text-style');
        const fillResult = read(style, 'fills');
        if (fillResult.available && Array.isArray(fillResult.value)) {
          values.paintRef = internValue(fillResult.value, 'P', pools.paints, paintReverse, mixedSentinel);
        }
        if (Object.keys(values).length > 0) record.text = values;
      } else if (styleType === 'GRID') {
        const layoutGrids = read(style, 'layoutGrids');
        const json = toJsonValue(layoutGrids.value, mixedSentinel);
        if (layoutGrids.available && json !== undefined) record.layoutGrids = json;
      }
      pools.local[id] = record;
    }
    onProgress?.('styles', Math.min(offset + batch.length, sortedIds.length), sortedIds.length);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

async function buildVariables(
  figmaApi: PluginAPI,
  aliases: Set<string>,
  tokens: ExportDocument['tokens'],
  mixedSentinel: unknown,
  errors: ExportDocument['stats']['errors'],
  onProgress?: SerializeInput['onProgress']
): Promise<Map<string, Variable>> {
  const pending = new Set(aliases);
  const processed = new Set<string>();
  const collectionIds = new Set<string>();
  const variableObjects = new Map<string, Variable>();

  while (pending.size > 0) {
    const batch = [...pending].filter((id) => !processed.has(id)).sort().slice(0, LOOKUP_BATCH_SIZE);
    if (batch.length === 0) break;
    for (const id of batch) {
      pending.delete(id);
      processed.add(id);
    }
    const results = await Promise.allSettled(batch.map((id) => figmaApi.variables.getVariableByIdAsync(id)));
    for (let index = 0; index < batch.length; index += 1) {
      const id = batch[index];
      const result = results[index];
      if (!id || !result) continue;
      if (result.status === 'rejected') {
        addError(errors, undefined, 'read-variable', `${id}: ${errorMessage(result.reason)}`);
        continue;
      }
      const variable = result.value;
      if (!variable) continue;
      variableObjects.set(id, variable);
      const record = pickFields(
        variable,
        ['id', 'name', 'key', 'description', 'remote', 'resolvedType', 'variableCollectionId', 'scopes', 'hiddenFromPublishing', 'valuesByMode', 'codeSyntax'],
        mixedSentinel,
        errors,
        undefined,
        'read-variable'
      );
      if (typeof record.variableCollectionId === 'string') collectionIds.add(record.variableCollectionId);
      const values = read(variable, 'valuesByMode');
      if (values.available) collectAliasIds(values.value, pending);
      tokens.variables[id] = record;
    }
    onProgress?.('variables', processed.size, processed.size + pending.size);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }

  const sortedCollectionIds = [...collectionIds].sort();
  for (let offset = 0; offset < sortedCollectionIds.length; offset += LOOKUP_BATCH_SIZE) {
    const batch = sortedCollectionIds.slice(offset, offset + LOOKUP_BATCH_SIZE);
    const results = await Promise.allSettled(batch.map((id) => figmaApi.variables.getVariableCollectionByIdAsync(id)));
    for (let index = 0; index < batch.length; index += 1) {
      const id = batch[index];
      const result = results[index];
      if (!id || !result) continue;
      if (result.status === 'rejected') {
        addError(errors, undefined, 'read-variable-collection', `${id}: ${errorMessage(result.reason)}`);
        continue;
      }
      const collection = result.value;
      if (!collection) continue;
      tokens.collections[id] = pickFields(
        collection,
        ['id', 'name', 'key', 'remote', 'isExtension', 'modes', 'defaultModeId', 'hiddenFromPublishing'],
        mixedSentinel,
        errors,
        undefined,
        'read-variable-collection'
      );
    }
    onProgress?.('collections', Math.min(offset + batch.length, sortedCollectionIds.length), sortedCollectionIds.length);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  return variableObjects;
}

function aliasesUsedByNode(record: JsonRecord, styles: ExportDocument['styles']): Set<string> {
  const aliases = new Set<string>();
  collectAliasIds(record, aliases);

  const appearance = asRecord(record.appearance);
  const paintRefs = asRecord(appearance?.paintRefs);
  if (paintRefs) {
    for (const paintReference of Object.values(paintRefs)) {
      const reference = asRecord(paintReference)?.ref;
      if (typeof reference === 'string' && styles.paints[reference] !== undefined) {
        collectAliasIds(styles.paints[reference], aliases);
      }
    }
  }

  const text = asRecord(record.text);
  if (Array.isArray(text?.runs)) {
    for (const run of text.runs) {
      const styleReference = asRecord(run)?.styleRef;
      if (typeof styleReference !== 'string') continue;
      const textStyle = asRecord(styles.text[styleReference]);
      if (!textStyle) continue;
      collectAliasIds(textStyle, aliases);
      if (typeof textStyle.paintRef === 'string' && styles.paints[textStyle.paintRef] !== undefined) {
        collectAliasIds(styles.paints[textStyle.paintRef], aliases);
      }
    }
  }

  const styleRefs = asRecord(record.styleRefs);
  if (styleRefs) {
    for (const styleReference of Object.values(styleRefs)) {
      if (typeof styleReference !== 'string') continue;
      const localStyle = styles.local[styleReference];
      if (localStyle) collectAliasIds(localStyle, aliases);
    }
  }
  return aliases;
}

function variableModeSource(node: SceneNodeLike, collectionId: string): JsonRecord {
  let current: unknown = node;
  let depth = 0;
  const visited = new Set<unknown>();
  while (current && !visited.has(current)) {
    visited.add(current);
    const modes = asRecord(read(current, 'explicitVariableModes').value);
    if (modes && typeof modes[collectionId] === 'string') {
      return {
        modeId: modes[collectionId] as string,
        source: depth === 0 ? 'explicit' : 'inherited',
        sourceNodeId: String(read(current, 'id').value ?? '')
      };
    }
    current = read(current, 'parent').value;
    depth += 1;
  }
  return { source: 'collection-default' };
}

function applyVariableResolutions(
  nodes: Record<string, JsonRecord>,
  nodeObjects: Map<string, SceneNodeLike>,
  variables: Map<string, Variable>,
  styles: ExportDocument['styles'],
  errors: ExportDocument['stats']['errors']
): void {
  for (const [nodeId, record] of Object.entries(nodes)) {
    const node = nodeObjects.get(nodeId);
    if (!node) continue;
    const resolutions: JsonRecord = {};
    for (const aliasId of [...aliasesUsedByNode(record, styles)].sort()) {
      const variable = variables.get(aliasId);
      if (!variable) continue;
      try {
        const resolve = read(variable, 'resolveForConsumer');
        if (typeof resolve.value !== 'function') continue;
        const resolved = Reflect.apply(resolve.value, variable, [node]);
        if (!isRecord(resolved)) continue;
        const value = toJsonValue(resolved.value);
        const resolvedType = typeof resolved.resolvedType === 'string' ? resolved.resolvedType : undefined;
        const collectionId = String(read(variable, 'variableCollectionId').value ?? '');
        const mode = collectionId ? variableModeSource(node, collectionId) : {};
        const entry: JsonRecord = { ...mode };
        if (resolvedType) entry.resolvedType = resolvedType;
        if (value !== undefined) entry.value = value;
        resolutions[aliasId] = entry;
      } catch (error) {
        addError(errors, nodeId, 'resolve-variable-for-node', `${aliasId}: ${errorMessage(error)}`);
      }
    }
    if (Object.keys(resolutions).length > 0) record.resolvedVariables = resolutions;
  }
}

export async function serializeFigmaTree(input: SerializeInput): Promise<ExportDocument> {
  const { figma: figmaApi, page, roots, options } = input;
  const mixedSentinel = figmaApi.mixed;
  const errors: ExportDocument['stats']['errors'] = [];
  const nodes: Record<string, JsonRecord> = {};
  const components: Record<string, JsonRecord> = {};
  const styles: ExportDocument['styles'] = { paints: {}, effects: {}, text: {}, local: {} };
  const tokens: ExportDocument['tokens'] = { collections: {}, variables: {} };
  const paintReverse = new Map<string, string>();
  const effectReverse = new Map<string, string>();
  const textReverse = new Map<string, string>();
  const styleIds = new Set<string>();
  const pendingComponents: PendingComponent[] = [];
  const nodeObjects = new Map<string, SceneNodeLike>();
  const rootsIncluded: string[] = [];
  const stack: TraversalTask[] = [];
  let hiddenNodesOmitted = 0;
  let childRootsOmittedByOptions = 0;
  let visited = 0;
  const initialTotal = roots.reduce((count, root) => count + Math.max(1, getNodeChildren(root).length), 0);

  for (let index = roots.length - 1; index >= 0; index -= 1) {
    const root = roots[index];
    if (root) stack.push({ node: root, underHiddenAncestor: false });
  }

  while (stack.length > 0) {
    const batch: TraversalTask[] = [];
    while (stack.length > 0 && batch.length < NODE_BATCH_SIZE) {
      const task = stack.pop();
      if (task) batch.push(task);
    }

    for (const task of batch) {
      const node = task.node;
      const nodeIdRead = read(node, 'id');
      const nodeId = typeof nodeIdRead.value === 'string' ? nodeIdRead.value : `unknown-${visited}`;
      const visible = read(node, 'visible');
      const isHidden = task.underHiddenAncestor || (visible.available && visible.value === false);
      if (!options.includeHidden && isHidden) {
        hiddenNodesOmitted += 1;
        const hiddenChildren = read(node, 'children');
        if (hiddenChildren.error) addError(errors, nodeId, 'traverse-hidden-node', hiddenChildren.error);
        const hiddenChildNodes = hiddenChildren.available && Array.isArray(hiddenChildren.value)
          ? hiddenChildren.value as SceneNodeLike[]
          : [];
        for (const child of hiddenChildNodes.slice().reverse()) stack.push({ node: child, underHiddenAncestor: true });
        visited += 1;
        continue;
      }

      const nameResult = read(node, 'name');
      const typeResult = read(node, 'type');
      const record: JsonRecord = {
        id: nodeId,
        name: typeof nameResult.value === 'string' ? nameResult.value : '',
        type: typeof typeResult.value === 'string' ? typeResult.value : 'UNKNOWN',
        childIds: []
      };
      if (nodeIdRead.error) addError(errors, nodeId, 'read-node-id', nodeIdRead.error);
      if (nameResult.error) addError(errors, nodeId, 'read-node-name', nameResult.error);
      if (typeResult.error) addError(errors, nodeId, 'read-node-type', typeResult.error);

      for (const field of ['visible', 'locked', 'expanded'] as const) {
        const result = read(node, field);
        if (result.error) addError(errors, nodeId, 'read-node-state', `${field}: ${errorMessage(result.error)}`);
        if (result.available) {
          const json = toJsonValue(result.value, mixedSentinel);
          if (json !== undefined) record[field] = json;
        }
      }

      const parent = read(node, 'parent');
      if (parent.error) addError(errors, nodeId, 'read-parent', parent.error);
      const parentId = read(parent.value, 'id');
      if (parentId.error) addError(errors, nodeId, 'read-parent-id', parentId.error);
      if (parentId.available && typeof parentId.value === 'string') record.parentId = parentId.value;

      const geometry = pickFields(node, GEOMETRY_FIELDS, mixedSentinel, errors, nodeId, 'read-geometry');
      addNonEmpty(record, 'geometry', geometry);
      const layout = pickFields(node, LAYOUT_FIELDS, mixedSentinel, errors, nodeId, 'read-layout');
      addNonEmpty(record, 'layout', layout);
      const explicitModes = read(node, 'explicitVariableModes');
      if (explicitModes.error) addError(errors, nodeId, 'read-variable-modes', explicitModes.error);
      if (explicitModes.available) {
        const json = toJsonValue(explicitModes.value, mixedSentinel);
        if (json !== undefined) record.explicitVariableModes = json;
      }
      const appearance = pickFields(node, APPEARANCE_FIELDS, mixedSentinel, errors, nodeId, 'read-appearance');
      const fillsRef = exportPaintGroup(node, 'fills', 'P', styles.paints, paintReverse, mixedSentinel, errors, nodeId);
      const strokesRef = exportPaintGroup(node, 'strokes', 'P', styles.paints, paintReverse, mixedSentinel, errors, nodeId);
      const effectsRef = exportPaintGroup(node, 'effects', 'E', styles.effects, effectReverse, mixedSentinel, errors, nodeId);
      const paintRefs: JsonRecord = {};
      if (fillsRef !== undefined) paintRefs.fills = typeof fillsRef === 'string' ? { ref: fillsRef } : fillsRef;
      if (strokesRef !== undefined) paintRefs.strokes = typeof strokesRef === 'string' ? { ref: strokesRef } : strokesRef;
      if (effectsRef !== undefined) paintRefs.effects = typeof effectsRef === 'string' ? { ref: effectsRef } : effectsRef;
      if (Object.keys(paintRefs).length > 0) appearance.paintRefs = paintRefs;
      addNonEmpty(record, 'appearance', appearance);

      const styleRefs: JsonRecord = {};
      for (const [field, outputKey] of STYLE_ID_FIELDS) {
        const result = read(node, field);
        if (result.error) addError(errors, nodeId, 'read-style-reference', `${field}: ${errorMessage(result.error)}`);
        if (result.available && typeof result.value === 'string' && result.value.length > 0) {
          styleRefs[outputKey] = result.value;
          styleIds.add(result.value);
        }
      }
      if (Object.keys(styleRefs).length > 0) record.styleRefs = styleRefs;

      if (String(typeResult.value) === 'TEXT' || String(typeResult.value) === 'TEXT_PATH') {
        const text: JsonRecord = {};
        const characters = read(node, 'characters');
        if (characters.available && typeof characters.value === 'string') text.characters = characters.value;
        if (characters.error) addError(errors, nodeId, 'read-text', `characters: ${errorMessage(characters.error)}`);
        Object.assign(text, pickFields(node, TEXT_FIELDS, mixedSentinel, errors, nodeId, 'read-text'));
        const segmentsFunction = read(node, 'getStyledTextSegments');
        if (segmentsFunction.available && typeof segmentsFunction.value === 'function') {
          try {
            const segments = Reflect.apply(segmentsFunction.value, node, [TEXT_SEGMENT_FIELDS]) as unknown;
            if (Array.isArray(segments)) {
              const runs: JsonValue[] = [];
              for (const segmentValue of segments) {
                if (!isRecord(segmentValue)) continue;
                const run: JsonRecord = {};
                if (typeof segmentValue.start === 'number') run.start = segmentValue.start;
                if (typeof segmentValue.end === 'number') run.end = segmentValue.end;
                const textStyle: JsonRecord = {};
                for (const field of TEXT_SEGMENT_FIELDS) {
                  const value = segmentValue[field];
                  if (value === undefined) continue;
                  if (field.endsWith('StyleId') && typeof value === 'string' && value.length > 0) styleIds.add(value);
                  if (field === 'fills' && Array.isArray(value)) {
                    textStyle.paintRef = internValue(value, 'P', styles.paints, paintReverse, mixedSentinel);
                    continue;
                  }
                  const json = toJsonValue(value, mixedSentinel);
                  if (json !== undefined) textStyle[field] = json;
                }
                if (Object.keys(textStyle).length > 0) {
                  const styleJson = textStyle as JsonValue;
                  const signature = canonicalJson(styleJson);
                  let styleRef = textReverse.get(signature);
                  if (!styleRef) {
                    styleRef = stableId('T', Object.keys(styles.text).length + 1);
                    styles.text[styleRef] = textStyle;
                    textReverse.set(signature, styleRef);
                  }
                  run.styleRef = styleRef;
                }
                if (Object.keys(run).length > 0) runs.push(run);
              }
              text.runs = runs;
            }
          } catch (error) {
            addError(errors, nodeId, 'read-text-runs', error);
          }
        }
        addNonEmpty(record, 'text', text);
      }

      const componentProperties = read(node, 'componentProperties');
      if (componentProperties.error) addError(errors, nodeId, 'read-component-properties', componentProperties.error);
      if (componentProperties.available) {
        const json = toJsonValue(componentProperties.value, mixedSentinel);
        if (json !== undefined) record.componentProperties = json;
      }
      const componentDefinitions = read(node, 'componentPropertyDefinitions');
      if (componentDefinitions.error) addError(errors, nodeId, 'read-component-definitions', componentDefinitions.error);
      if (componentDefinitions.available) {
        const json = toJsonValue(componentDefinitions.value, mixedSentinel);
        if (json !== undefined) record.componentPropertyDefinitions = json;
      }
      const componentPropertyReferences = read(node, 'componentPropertyReferences');
      if (componentPropertyReferences.error) addError(errors, nodeId, 'read-component-property-references', componentPropertyReferences.error);
      if (componentPropertyReferences.available && componentPropertyReferences.value !== null) {
        const json = toJsonValue(componentPropertyReferences.value, mixedSentinel);
        if (json !== undefined) record.componentPropertyReferences = json;
      }
      if (String(typeResult.value) === 'INSTANCE') {
        const overrides = read(node, 'overrides');
        if (overrides.available) {
          const json = toJsonValue(overrides.value, mixedSentinel);
          if (json !== undefined) record.overrides = json;
        }
        pendingComponents.push({ nodeId, node });
      }
      if (String(typeResult.value) === 'COMPONENT' || String(typeResult.value) === 'COMPONENT_SET') {
        record.componentDefinitionId = nodeId;
        if (options.includeComponents) registerComponent(node, components, mixedSentinel);
      }

      const childrenResult = read(node, 'children');
      if (childrenResult.error) addError(errors, nodeId, 'read-children', childrenResult.error);
      const rawChildren = childrenResult.available && Array.isArray(childrenResult.value)
        ? childrenResult.value as SceneNodeLike[]
        : [];
      const canExpand = !(String(typeResult.value) === 'INSTANCE' && !options.includeInstanceChildren)
        && !(String(typeResult.value) === 'COMPONENT' || String(typeResult.value) === 'COMPONENT_SET')
        ? true
        : String(typeResult.value) === 'INSTANCE'
          ? options.includeInstanceChildren
          : options.includeComponentChildren;
      const includedChildren: SceneNodeLike[] = [];
      if (canExpand) {
        for (const child of rawChildren) {
          const childVisible = read(child, 'visible');
          if (!options.includeHidden && childVisible.available && childVisible.value === false) {
            stack.push({ node: child, underHiddenAncestor: true });
          } else {
            includedChildren.push(child);
          }
        }
      } else {
        childRootsOmittedByOptions += rawChildren.length;
        if (rawChildren.length > 0) record.childrenOmittedReason = String(typeResult.value) === 'INSTANCE'
          ? 'INSTANCE_CONTENT_DISABLED'
          : 'COMPONENT_CONTENT_DISABLED';
      }
      record.childIds = includedChildren.map((child) => {
        const childId = read(child, 'id').value;
        return typeof childId === 'string' ? childId : '';
      }).filter((id) => id.length > 0);

      if (typeResult.value === 'INSTANCE' && !options.includeInstanceChildren && rawChildren.length > 0) {
        record.childIds = [];
      }
      if (nodeId !== `unknown-${visited}`) {
        nodes[nodeId] = record;
        nodeObjects.set(nodeId, node);
        if (!record.parentId || !nodes[String(record.parentId)]) rootsIncluded.push(nodeId);
      }
      if (canExpand) {
        for (let index = includedChildren.length - 1; index >= 0; index -= 1) {
          const child = includedChildren[index];
          if (child) stack.push({ node: child, underHiddenAncestor: false });
        }
      }
      visited += 1;
    }

    input.onProgress?.('nodes', visited, Math.max(initialTotal, visited + stack.length));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }

  for (let offset = 0; offset < pendingComponents.length; offset += LOOKUP_BATCH_SIZE) {
    const batch = pendingComponents.slice(offset, offset + LOOKUP_BATCH_SIZE);
    const results = await Promise.allSettled(batch.map(({ node }) => {
      const method = read(node, 'getMainComponentAsync');
      if (method.error) return Promise.reject(method.error);
      if (typeof method.value !== 'function') return Promise.resolve(null);
      return Reflect.apply(method.value, node, []) as Promise<ComponentNode | null>;
    }));
    for (let index = 0; index < batch.length; index += 1) {
      const pendingComponent = batch[index];
      const result = results[index];
      if (!pendingComponent || !result) continue;
      if (result.status === 'rejected') {
        addError(errors, pendingComponent.nodeId, 'read-component-reference', result.reason);
        continue;
      }
      if (!result.value) continue;
      const target = nodes[pendingComponent.nodeId];
      if (target) pushComponentReference(target, result.value, components, options.includeComponents, mixedSentinel);
    }
    input.onProgress?.('components', Math.min(offset + batch.length, pendingComponents.length), pendingComponents.length);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }

  for (const node of Object.values(nodes)) collectStyleIds(node, styleIds);
  await buildStyles(figmaApi, styleIds, styles, paintReverse, effectReverse, mixedSentinel, errors, input.onProgress);

  const aliases = new Set<string>();
  collectAliasIds(nodes, aliases);
  collectAliasIds(styles, aliases);
  collectAliasIds(components, aliases);
  const variableObjects = await buildVariables(figmaApi, aliases, tokens, mixedSentinel, errors, input.onProgress);
  applyVariableResolutions(nodes, nodeObjects, variableObjects, styles, errors);

  const rootSet = new Set(roots.map((root) => String(read(root, 'id').value ?? '')));
  const orderedRoots = rootsIncluded.filter((id, index) => rootsIncluded.indexOf(id) === index && (rootSet.has(id) || !nodes[id]?.parentId || !nodes[String(nodes[id]?.parentId)]));
  const doc: ExportDocument = {
    schemaVersion: '1.0.0',
    document: {
      name: String(read(figmaApi.root, 'name').value ?? ''),
      page: {
        id: String(read(page, 'id').value ?? ''),
        name: String(read(page, 'name').value ?? '')
      },
      exportedAt: new Date().toISOString(),
      scope: options.scope,
      childOrder: 'back-to-front'
    },
    roots: orderedRoots,
    nodes,
    components,
    styles,
    tokens,
    stats: {
      nodeCount: Object.keys(nodes).length,
      hiddenNodesOmitted,
      childRootsOmittedByOptions,
      estimatedBytes: 0,
      errors
    },
    limitations: LIMITATIONS
  };
  return doc;
}

export async function buildSnapshot(input: SerializeInput): Promise<ExportSnapshot> {
  const doc = await serializeFigmaTree(input);
  const json = JSON.stringify(doc, null, input.options.compact ? undefined : 2);
  let finalJson = json;
  let bytes = utf8ByteLength(finalJson);
  for (let pass = 0; pass < 3; pass += 1) {
    doc.stats.estimatedBytes = bytes;
    finalJson = JSON.stringify(doc, null, input.options.compact ? undefined : 2);
    const nextBytes = utf8ByteLength(finalJson);
    if (nextBytes === bytes) break;
    bytes = nextBytes;
  }
  const signature = JSON.stringify({
    pageId: doc.document.page.id,
    rootIds: input.roots.map((node) => String(read(node, 'id').value ?? '')),
    options: input.options
  });
  return {
    signature,
    json: finalJson,
    nodeCount: doc.stats.nodeCount,
    bytes: utf8ByteLength(finalJson),
    errors: doc.stats.errors.length
  };
}

