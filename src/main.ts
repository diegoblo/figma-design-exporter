import { buildSnapshot } from './exporter/serializer.ts';
import type { ExportOptions, ExportSnapshot } from './exporter/schema.ts';
import { isRecord } from './exporter/normalize.ts';

interface TransferState {
  id: string;
  chunks: string[];
  nextIndex: number;
}

let activeOptions: ExportOptions | null = null;
let latestSnapshot: ExportSnapshot | null = null;
let analysisGeneration = 0;
let transfer: TransferState | null = null;
let transferCounter = 0;
const watchedPages = new Set<string>();

function sendToUi(message: Record<string, unknown>): void {
  try {
    figma.ui.postMessage(message);
  } catch {
    // The UI may have been closed while an asynchronous batch was running.
  }
}

function optionsFrom(value: unknown): ExportOptions | undefined {
  if (!isRecord(value)) return undefined;
  const scope = value.scope === 'page' ? 'page' : value.scope === 'selection' ? 'selection' : undefined;
  if (!scope) return undefined;
  return {
    scope,
    includeHidden: value.includeHidden === true,
    includeInstanceChildren: value.includeInstanceChildren !== false,
    includeComponentChildren: value.includeComponentChildren !== false,
    includeComponents: value.includeComponents !== false,
    compact: value.compact !== false
  };
}

function safeFilePart(value: string): string {
  const sanitized = value
    .normalize('NFKC')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '');
  return sanitized.slice(0, 90) || 'figma-export';
}

function currentRoots(options: ExportOptions): readonly SceneNode[] {
  return options.scope === 'page' ? figma.currentPage.children : figma.currentPage.selection;
}

function signatureFor(options: ExportOptions, roots: readonly SceneNode[]): string {
  return JSON.stringify({
    pageId: figma.currentPage.id,
    rootIds: roots.map((node) => node.id),
    options
  });
}

async function analyze(options: ExportOptions, exportAfter = false): Promise<void> {
  const generation = ++analysisGeneration;
  activeOptions = options;
  latestSnapshot = null;
  sendToUi({ type: 'ANALYSIS_START' });
  try {
    const page = figma.currentPage;
    await page.loadAsync();
    figma.skipInvisibleInstanceChildren = false;
    const roots = currentRoots(options);
    const expectedSignature = signatureFor(options, roots);
    const snapshot = await buildSnapshot({
      figma,
      page,
      roots,
      options,
      onProgress(stage, completed, total) {
        if (generation === analysisGeneration) {
          sendToUi({ type: 'PROGRESS', stage, completed, total });
        }
      }
    });
    if (generation !== analysisGeneration) return;
    if (snapshot.signature !== expectedSignature) snapshot.signature = expectedSignature;
    latestSnapshot = snapshot;
    sendToUi({
      type: 'PREVIEW_READY',
      nodeCount: snapshot.nodeCount,
      bytes: snapshot.bytes,
      errors: snapshot.errors,
      signature: snapshot.signature,
      hasSelection: options.scope !== 'selection' || roots.length > 0,
      hiddenNodesOmitted: readHiddenCount(snapshot.json),
      fileName: exportFileName(options)
    });
    if (exportAfter && generation === analysisGeneration) beginTransfer();
  } catch (error) {
    if (generation !== analysisGeneration) return;
    const message = error instanceof Error ? error.message : String(error);
    sendToUi({ type: 'ERROR', message: `No se pudo analizar el documento: ${message}` });
  }
}

function readHiddenCount(json: string): number {
  try {
    const document = JSON.parse(json) as { stats?: { hiddenNodesOmitted?: unknown } };
    const value = document.stats?.hiddenNodesOmitted;
    return typeof value === 'number' ? value : 0;
  } catch {
    return 0;
  }
}

function exportFileName(options: ExportOptions): string {
  const fileName = safeFilePart(figma.root.name || 'figma-design');
  const pageName = safeFilePart(figma.currentPage.name || 'page');
  return `${fileName}-${options.scope === 'page' ? pageName : 'selection'}.json`;
}

function splitSafely(text: string, maxUnits = 96 * 1024): string[] {
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + maxUnits, text.length);
    if (end < text.length) {
      const last = text.charCodeAt(end - 1);
      if (last >= 0xd800 && last <= 0xdbff) end -= 1;
    }
    chunks.push(text.slice(start, end));
    start = end;
  }
  if (chunks.length === 0) chunks.push('');
  return chunks;
}

function sendNextChunk(): void {
  if (!transfer) return;
  const index = transfer.nextIndex;
  const chunk = transfer.chunks[index];
  if (chunk === undefined) {
    sendToUi({ type: 'TRANSFER_END', transferId: transfer.id, total: transfer.chunks.length });
    return;
  }
  sendToUi({
    type: 'EXPORT_CHUNK',
    transferId: transfer.id,
    index,
    total: transfer.chunks.length,
    chunk
  });
}

function beginTransfer(): void {
  if (!latestSnapshot || !activeOptions) {
    sendToUi({ type: 'ERROR', message: 'Actualiza los datos antes de exportar.' });
    return;
  }
  transferCounter += 1;
  const id = `export-${Date.now()}-${transferCounter}`;
  transfer = { id, chunks: splitSafely(latestSnapshot.json), nextIndex: 0 };
  sendToUi({
    type: 'EXPORT_START',
    transferId: id,
    total: transfer.chunks.length,
    bytes: latestSnapshot.bytes,
    fileName: exportFileName(activeOptions)
  });
  sendNextChunk();
}

function invalidate(reason: string): void {
  latestSnapshot = null;
  analysisGeneration += 1;
  sendToUi({ type: 'INVALIDATED', reason });
}

function watchPage(page: PageNode): void {
  if (watchedPages.has(page.id)) return;
  watchedPages.add(page.id);
  page.on('nodechange', () => invalidate('document'));
}

figma.showUI(__html__, { width: 390, height: 690 });
figma.skipInvisibleInstanceChildren = false;
watchPage(figma.currentPage);

figma.on('selectionchange', () => {
  invalidate('selection');
  sendToUi({ type: 'INPUTS_CHANGED', pageName: figma.currentPage.name });
});

figma.on('currentpagechange', () => {
  const page = figma.currentPage;
  watchPage(page);
  invalidate('page');
  sendToUi({ type: 'INPUTS_CHANGED', pageName: page.name });
});

figma.on('stylechange', () => invalidate('styles'));

figma.ui.onmessage = (incoming: unknown) => {
  if (!isRecord(incoming) || typeof incoming.type !== 'string') return;
  switch (incoming.type) {
    case 'READY': {
      const options = optionsFrom(incoming.options);
      if (options) void analyze(options);
      break;
    }
    case 'ANALYZE': {
      const options = optionsFrom(incoming.options);
      if (options) void analyze(options);
      break;
    }
    case 'EXPORT': {
      if (activeOptions) void analyze(activeOptions, true);
      else sendToUi({ type: 'ERROR', message: 'Actualiza los datos antes de exportar.' });
      break;
    }
    case 'EXPORT_ACK': {
      if (!transfer || incoming.transferId !== transfer.id || incoming.index !== transfer.nextIndex) return;
      transfer.nextIndex += 1;
      sendNextChunk();
      break;
    }
    case 'DOWNLOAD_DONE': {
      if (!transfer || incoming.transferId !== transfer.id) return;
      transfer = null;
      sendToUi({ type: 'EXPORT_COMPLETE' });
      break;
    }
    case 'DOWNLOAD_ERROR': {
      if (transfer && incoming.transferId === transfer.id) transfer = null;
      sendToUi({ type: 'DOWNLOAD_FAILED', message: 'El navegador no inició la descarga. Vuelve a pulsar «Exportar JSON».' });
      break;
    }
  }
};

