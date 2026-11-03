import test from 'node:test';
import assert from 'node:assert/strict';
import { serializeFigmaTree, buildSnapshot } from '../src/exporter/serializer.ts';

function makeNode(id, type = 'FRAME', fields = {}, children = []) {
  const node = {
    id,
    name: id,
    type,
    visible: true,
    locked: false,
    parent: null,
    children,
    ...fields
  };
  for (const child of children) child.parent = node;
  return node;
}

function makeFigma({ styles = {}, variables = {}, collections = {} } = {}) {
  return {
    mixed: Symbol('mixed'),
    root: { name: 'Example file' },
    getStyleByIdAsync: async (id) => styles[id] ?? null,
    variables: {
      getVariableByIdAsync: async (id) => variables[id] ?? null,
      getVariableCollectionByIdAsync: async (id) => collections[id] ?? null
    }
  };
}

function makePage() {
  return {
    id: 'page-1',
    name: 'Page 1',
    loadAsync: async () => undefined
  };
}

function makeOptions(overrides = {}) {
  return {
    scope: 'selection',
    includeHidden: false,
    includeInstanceChildren: true,
    includeComponentChildren: true,
    includeComponents: true,
    compact: true,
    ...overrides
  };
}

function parseJson(snapshot) {
  return JSON.parse(snapshot.json);
}

test('Auto Layout, exact dimensions, padding and sizing modes are preserved', async () => {
  const frame = makeNode('frame-1', 'FRAME', {
    x: 10.25,
    y: 4.5,
    width: 320,
    height: 180,
    layoutMode: 'HORIZONTAL',
    primaryAxisSizingMode: 'AUTO',
    counterAxisSizingMode: 'FIXED',
    primaryAxisAlignItems: 'SPACE_BETWEEN',
    counterAxisAlignItems: 'CENTER',
    itemSpacing: 12.5,
    paddingTop: 8,
    paddingRight: 16,
    paddingBottom: 24,
    paddingLeft: 32,
    layoutWrap: 'WRAP'
  });
  const doc = await serializeFigmaTree({
    figma: makeFigma(), page: makePage(), roots: [frame], options: makeOptions()
  });
  assert.equal(doc.nodes['frame-1'].geometry.x, 10.25);
  assert.equal(doc.nodes['frame-1'].layout.layoutMode, 'HORIZONTAL');
  assert.equal(doc.nodes['frame-1'].layout.itemSpacing, 12.5);
  assert.equal(doc.nodes['frame-1'].layout.paddingLeft, 32);
  assert.equal(doc.nodes['frame-1'].layout.layoutWrap, 'WRAP');
});

test('component instances retain properties, direct overrides and component definition references', async () => {
  const component = makeNode('button-main', 'COMPONENT', {
    key: 'component-key',
    description: 'Primary button',
    componentPropertyDefinitions: { Label: { type: 'TEXT', defaultValue: 'Continue' } }
  });
  const label = makeNode('button-instance-label', 'TEXT', { characters: 'Save' });
  const instance = makeNode('button-instance', 'INSTANCE', {
    componentProperties: { Label: { type: 'TEXT', value: 'Save' } },
    overrides: [{ id: 'button-label', overriddenFields: ['characters'] }],
    getMainComponentAsync: async () => component
  }, [label]);
  const doc = await serializeFigmaTree({
    figma: makeFigma(), page: makePage(), roots: [instance], options: makeOptions()
  });
  assert.equal(doc.nodes['button-instance'].componentProperties.Label.value, 'Save');
  assert.equal(doc.nodes['button-instance'].overrides[0].overriddenFields[0], 'characters');
  assert.equal(doc.nodes['button-instance'].componentRef.id, 'button-main');
  assert.ok(doc.nodes['button-instance-label']);
  assert.equal(doc.components['button-main'].key, 'component-key');
  assert.equal(doc.components['button-main'].description, 'Primary button');

  const collapsed = await serializeFigmaTree({
    figma: makeFigma(), page: makePage(), roots: [instance], options: makeOptions({ includeInstanceChildren: false })
  });
  assert.equal(collapsed.nodes['button-instance'].childrenOmittedReason, 'INSTANCE_CONTENT_DISABLED');
  assert.equal(collapsed.nodes['button-instance'].componentRef.id, 'button-main');
  assert.equal('button-instance-label' in collapsed.nodes, false);
  assert.equal(collapsed.stats.childRootsOmittedByOptions, 1);
});

test('page scope keeps all page roots in back-to-front order', async () => {
  const first = makeNode('page-root-back', 'FRAME');
  const second = makeNode('page-root-front', 'COMPONENT');
  const doc = await serializeFigmaTree({
    figma: makeFigma(), page: makePage(), roots: [first, second], options: makeOptions({ scope: 'page' })
  });
  assert.equal(doc.document.scope, 'page');
  assert.deepEqual(doc.roots, ['page-root-back', 'page-root-front']);
});

test('mixed text styles are represented as exact UTF-16 runs with reusable style records', async () => {
  const text = makeNode('text-1', 'TEXT', {
    characters: 'Hello world',
    fontName: { family: 'Inter', style: 'Regular' },
    fontSize: 16,
    textStyleId: 'style-text',
    getStyledTextSegments: () => [
      { start: 0, end: 6, characters: 'Hello ', fontName: { family: 'Inter', style: 'Bold' }, fontSize: 16, fillStyleId: 'style-fill' },
      { start: 6, end: 11, characters: 'world', fontName: { family: 'Inter', style: 'Regular' }, fontSize: 13, fillStyleId: 'style-fill' }
    ]
  });
  const styles = {
    'style-text': { id: 'style-text', type: 'TEXT', name: 'Body', fontName: { family: 'Inter', style: 'Regular' }, fontSize: 16 },
    'style-fill': { id: 'style-fill', type: 'PAINT', name: 'Ink', paints: [{ type: 'SOLID', color: { r: 0.1, g: 0.2, b: 0.3, a: 1 } }] }
  };
  const doc = await serializeFigmaTree({
    figma: makeFigma({ styles }), page: makePage(), roots: [text], options: makeOptions()
  });
  const record = doc.nodes['text-1'];
  assert.equal(record.text.characters, 'Hello world');
  assert.equal(record.text.runs.length, 2);
  assert.deepEqual(record.text.runs.map(({ start, end }) => [start, end]), [[0, 6], [6, 11]]);
  assert.notEqual(record.text.runs[0].styleRef, record.text.runs[1].styleRef);
  assert.equal(record.styleRefs.text, 'style-text');
  assert.equal(doc.styles.local['style-text'].name, 'Body');
  assert.equal(doc.styles.local['style-fill'].name, 'Ink');
});

test('bound variables keep collection modes and variable aliases', async () => {
  const consumer = makeNode('variable-consumer', 'RECTANGLE', {
    boundVariables: { fills: [{ type: 'VARIABLE_ALIAS', id: 'var-primary' }] }
  });
  const frame = makeNode('variable-frame', 'FRAME', {
    explicitVariableModes: { 'collection-1': 'dark' }
  }, [consumer]);
  const variable = {
    id: 'var-primary',
    name: 'Color/Primary',
    key: 'variable-key',
    resolvedType: 'COLOR',
    variableCollectionId: 'collection-1',
    valuesByMode: { light: { r: 0.2, g: 0.4, b: 0.8, a: 1 }, dark: { type: 'VARIABLE_ALIAS', id: 'var-secondary' } },
    resolveForConsumer: () => ({ resolvedType: 'COLOR', value: { r: 0.8, g: 0.2, b: 0.1, a: 1 } }),
    scopes: ['ALL_FILLS'],
    remote: false
  };
  const secondary = {
    id: 'var-secondary', name: 'Color/Secondary', resolvedType: 'COLOR',
    variableCollectionId: 'collection-1', valuesByMode: { light: { r: 1, g: 0, b: 0, a: 1 } }
  };
  const doc = await serializeFigmaTree({
    figma: makeFigma({
      variables: { 'var-primary': variable, 'var-secondary': secondary },
      collections: { 'collection-1': { id: 'collection-1', name: 'Theme', modes: [{ modeId: 'light', name: 'Light' }, { modeId: 'dark', name: 'Dark' }], defaultModeId: 'light', remote: false } }
    }),
    page: makePage(), roots: [frame], options: makeOptions()
  });
  assert.equal(doc.tokens.variables['var-primary'].valuesByMode.dark.id, 'var-secondary');
  assert.equal(doc.tokens.variables['var-primary'].valuesByMode.light.hex, '#3366CC');
  assert.equal(doc.tokens.variables['var-secondary'].name, 'Color/Secondary');
  assert.equal(doc.tokens.collections['collection-1'].modes.length, 2);
  assert.equal(doc.nodes['variable-consumer'].resolvedVariables['var-primary'].modeId, 'dark');
  assert.equal(doc.nodes['variable-consumer'].resolvedVariables['var-primary'].source, 'inherited');
  assert.equal(doc.nodes['variable-consumer'].resolvedVariables['var-primary'].value.hex, '#CC331A');
});

test('gradient paints and effects are preserved and repeated values are deduplicated', async () => {
  const gradient = [{
    type: 'GRADIENT_LINEAR',
    opacity: 0.9,
    gradientHandlePositions: [{ x: 0, y: 0 }, { x: 1, y: 1 }],
    gradientStops: [
      { position: 0, color: { r: 1, g: 0, b: 0, a: 1 } },
      { position: 1, color: { r: 0, g: 0, b: 1, a: 0.5 } }
    ]
  }];
  const effects = [{ type: 'DROP_SHADOW', color: { r: 0, g: 0, b: 0, a: 0.24 }, offset: { x: 0, y: 4 }, radius: 12, spread: 0, visible: true, blendMode: 'NORMAL' }];
  const one = makeNode('one', 'RECTANGLE', { fills: gradient, effects });
  const two = makeNode('two', 'RECTANGLE', { fills: gradient, effects });
  const doc = await serializeFigmaTree({
    figma: makeFigma(), page: makePage(), roots: [one, two], options: makeOptions()
  });
  assert.equal(Object.keys(doc.styles.paints).length, 1);
  assert.equal(Object.keys(doc.styles.effects).length, 1);
  const fillId = doc.nodes.one.appearance.paintRefs.fills.ref;
  assert.equal(doc.styles.paints[fillId][0].gradientStops[0].color.hex, '#FF0000');
  assert.equal(doc.styles.paints[fillId][0].gradientStops[1].color.a, 0.5);
  assert.equal(doc.nodes.one.appearance.paintRefs.fills.ref, doc.nodes.two.appearance.paintRefs.fills.ref);
  assert.equal(doc.nodes.one.appearance.paintRefs.effects.ref, doc.nodes.two.appearance.paintRefs.effects.ref);
  assert.equal(doc.styles.effects.E0001[0].radius, 12);
});

test('hidden nodes and all their descendants are omitted unless requested', async () => {
  const hiddenChild = makeNode('hidden-child', 'TEXT', { characters: 'secret' });
  const hidden = makeNode('hidden', 'FRAME', { visible: false }, [hiddenChild]);
  const shown = makeNode('shown', 'RECTANGLE');
  const root = makeNode('root', 'FRAME', {}, [shown, hidden]);
  const doc = await serializeFigmaTree({
    figma: makeFigma(), page: makePage(), roots: [root], options: makeOptions()
  });
  assert.deepEqual(Object.keys(doc.nodes), ['root', 'shown']);
  assert.deepEqual(doc.nodes.root.childIds, ['shown']);
  assert.equal(doc.stats.hiddenNodesOmitted, 2);
  const withHidden = await serializeFigmaTree({
    figma: makeFigma(), page: makePage(), roots: [root], options: makeOptions({ includeHidden: true })
  });
  assert.ok(withHidden.nodes.hidden);
  assert.ok(withHidden.nodes['hidden-child']);
});

test('deeply nested structures serialize iteratively without losing hierarchy', async () => {
  let root = makeNode('deep-0');
  const first = root;
  for (let index = 1; index < 3000; index += 1) {
    const child = makeNode(`deep-${index}`);
    root.children = [child];
    child.parent = root;
    root = child;
  }
  const doc = await serializeFigmaTree({
    figma: makeFigma(), page: makePage(), roots: [first], options: makeOptions()
  });
  assert.equal(doc.stats.nodeCount, 3000);
  assert.deepEqual(doc.nodes['deep-0'].childIds, ['deep-1']);
  assert.equal(doc.nodes['deep-2999'].parentId, 'deep-2998');
  assert.deepEqual(doc.roots, ['deep-0']);
});

test('missing and throwing properties are omitted or reported per node without aborting siblings', async () => {
  const broken = makeNode('broken', 'FRAME');
  Object.defineProperty(broken, 'absoluteTransform', { get() { throw new Error('unavailable geometry'); } });
  const healthy = makeNode('healthy', 'RECTANGLE', { width: 20.125, height: 10 });
  const snapshot = await buildSnapshot({
    figma: makeFigma(), page: makePage(), roots: [broken, healthy], options: makeOptions()
  });
  const doc = parseJson(snapshot);
  assert.ok(doc.nodes.broken);
  assert.ok(doc.nodes.healthy);
  assert.equal(doc.nodes.healthy.geometry.width, 20.125);
  assert.equal('absoluteTransform' in (doc.nodes.broken.geometry ?? {}), false);
  assert.ok(doc.stats.errors.some((entry) => entry.nodeId === 'broken' && entry.message.includes('absoluteTransform')));
  assert.equal(doc.stats.estimatedBytes, snapshot.bytes);
});
