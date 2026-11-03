import type { ExportOptions } from './exporter/schema.ts';
import { isRecord } from './exporter/normalize.ts';

type PluginMessage = Record<string, unknown>;

interface DownloadBuffer {
  chunks: string[];
  total: number;
  fileName: string;
  bytes: number;
}

const nodeCount = document.getElementById('nodeCount') as HTMLElement;
const fileSize = document.getElementById('fileSize') as HTMLElement;
const status = document.getElementById('status') as HTMLElement;
const progress = document.getElementById('progress') as HTMLElement;
const exportButton = document.getElementById('export') as HTMLButtonElement;
const refreshButton = document.getElementById('refresh') as HTMLButtonElement;
const downloadBuffers = new Map<string, DownloadBuffer>();

let ready = false;
let analysisTimer: number | undefined;
let currentNodeCount = 0;
let currentHiddenCount = 0;
let currentErrors = 0;
let analysisBusy = false;

function currentOptions(): ExportOptions {
  const scope = document.querySelector<HTMLInputElement>('input[name="scope"]:checked')?.value;
  return {
    scope: scope === 'page' ? 'page' : 'selection',
    includeHidden: (document.getElementById('includeHidden') as HTMLInputElement).checked,
    includeInstanceChildren: (document.getElementById('includeInstanceChildren') as HTMLInputElement).checked,
    includeComponentChildren: (document.getElementById('includeComponentChildren') as HTMLInputElement).checked,
    includeComponents: (document.getElementById('includeComponents') as HTMLInputElement).checked,
    compact: (document.getElementById('compact') as HTMLInputElement).checked
  };
}

function post(type: string, value: PluginMessage = {}): void {
  parent.postMessage({ pluginMessage: { type, ...value } }, '*');
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function setStatus(message: string, kind: 'normal' | 'error' | 'success' = 'normal'): void {
  status.textContent = message;
  status.className = `status${kind === 'normal' ? '' : ` ${kind}`}`;
}

function scheduleAnalysis(delay = 180): void {
  if (analysisTimer !== undefined) window.clearTimeout(analysisTimer);
  ready = false;
  exportButton.disabled = true;
  analysisTimer = window.setTimeout(() => {
    analysisBusy = true;
    nodeCount.textContent = '…';
    fileSize.textContent = '…';
    progress.style.width = '0%';
    setStatus('Analizando propiedades y jerarquía…');
    post('ANALYZE', { options: currentOptions() });
  }, delay);
}

function handleMessage(value: unknown): void {
  if (!isRecord(value) || typeof value.type !== 'string') return;
  const message = value as PluginMessage;
  switch (message.type) {
    case 'ANALYSIS_START':
      analysisBusy = true;
      ready = false;
      exportButton.disabled = true;
      setStatus('Analizando propiedades y jerarquía…');
      break;
    case 'PROGRESS': {
      const stage = String(message.stage ?? 'nodes');
      const completed = typeof message.completed === 'number' ? message.completed : 0;
      const total = typeof message.total === 'number' ? message.total : 0;
      if (stage === 'nodes') {
        setStatus(`Leyendo nodos: ${completed.toLocaleString('es-ES')}${total > 0 ? ` de ~${total.toLocaleString('es-ES')}` : ''}…`);
        if (total > 0) progress.style.width = `${Math.min(92, Math.round((completed / total) * 92))}%`;
      } else if (total > 0) {
        setStatus(`Resolviendo ${stage === 'components' ? 'componentes' : stage === 'styles' ? 'estilos' : 'variables'}: ${completed.toLocaleString('es-ES')} de ${total.toLocaleString('es-ES')}…`);
      }
      break;
    }
    case 'PREVIEW_READY': {
      analysisBusy = false;
      ready = true;
      currentNodeCount = typeof message.nodeCount === 'number' ? message.nodeCount : 0;
      currentHiddenCount = typeof message.hiddenNodesOmitted === 'number' ? message.hiddenNodesOmitted : 0;
      currentErrors = typeof message.errors === 'number' ? message.errors : 0;
      nodeCount.textContent = currentNodeCount.toLocaleString('es-ES');
      fileSize.textContent = typeof message.bytes === 'number' ? formatSize(message.bytes) : '—';
      progress.style.width = '100%';
      exportButton.disabled = false;
      if (message.hasSelection === false) {
        setStatus('No hay elementos seleccionados. Selecciona un frame o cambia a «Página actual».');
      } else {
        const details = [
          currentHiddenCount > 0 ? `${currentHiddenCount.toLocaleString('es-ES')} nodos ocultos omitidos` : '',
          currentErrors > 0 ? `${currentErrors.toLocaleString('es-ES')} errores de lectura (detallados en el JSON)` : ''
        ].filter(Boolean).join(' · ');
        setStatus(details ? `Análisis listo. ${details}.` : 'Análisis listo para exportar.');
      }
      break;
    }
    case 'INPUTS_CHANGED':
      scheduleAnalysis(250);
      break;
    case 'INVALIDATED':
      ready = false;
      exportButton.disabled = true;
      setStatus('El diseño cambió; actualizando el análisis…');
      scheduleAnalysis(250);
      break;
    case 'EXPORT_START': {
      const id = String(message.transferId ?? '');
      if (!id) break;
      exportButton.disabled = true;
      downloadBuffers.set(id, {
        chunks: [],
        total: typeof message.total === 'number' ? message.total : 0,
        fileName: typeof message.fileName === 'string' ? message.fileName : 'figma-export.json',
        bytes: typeof message.bytes === 'number' ? message.bytes : 0
      });
      setStatus('Preparando la descarga local…');
      break;
    }
    case 'EXPORT_CHUNK': {
      const id = String(message.transferId ?? '');
      const buffer = downloadBuffers.get(id);
      if (!buffer || typeof message.chunk !== 'string' || typeof message.index !== 'number') break;
      buffer.chunks[message.index] = message.chunk;
      progress.style.width = buffer.total > 0 ? `${Math.min(99, Math.round(((message.index + 1) / buffer.total) * 100))}%` : '90%';
      setStatus(`Enviando archivo a la descarga: ${message.index + 1} de ${buffer.total} bloques…`);
      post('EXPORT_ACK', { transferId: id, index: message.index });
      break;
    }
    case 'TRANSFER_END': {
      const id = String(message.transferId ?? '');
      const buffer = downloadBuffers.get(id);
      if (!buffer) break;
      try {
        const blob = new Blob(buffer.chunks, { type: 'application/json;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = buffer.fileName;
        anchor.style.display = 'none';
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
        setStatus(`Descarga iniciada: ${buffer.fileName} · ${formatSize(buffer.bytes)}.`, 'success');
        progress.style.width = '100%';
        downloadBuffers.delete(id);
        post('DOWNLOAD_DONE', { transferId: id });
      } catch (error) {
        downloadBuffers.delete(id);
        post('DOWNLOAD_ERROR', { transferId: id });
        setStatus(`No se pudo preparar la descarga: ${error instanceof Error ? error.message : String(error)}`, 'error');
      }
      break;
    }
    case 'EXPORT_COMPLETE':
      exportButton.disabled = !ready;
      break;
    case 'DOWNLOAD_FAILED':
      exportButton.disabled = !ready;
      setStatus(typeof message.message === 'string' ? message.message : 'No se inició la descarga.', 'error');
      break;
    case 'ERROR':
      analysisBusy = false;
      ready = false;
      exportButton.disabled = true;
      progress.style.width = '0%';
      setStatus(typeof message.message === 'string' ? message.message : 'Se produjo un error inesperado.', 'error');
      break;
  }
}

window.addEventListener('message', (event: MessageEvent<unknown>) => {
  const data = isRecord(event.data) ? event.data : undefined;
  if (data && 'pluginMessage' in data) handleMessage(data.pluginMessage);
});

document.querySelectorAll<HTMLInputElement>('input[name="scope"], .options input').forEach((input) => {
  input.addEventListener('change', () => scheduleAnalysis());
});

refreshButton.addEventListener('click', () => scheduleAnalysis(0));
exportButton.addEventListener('click', () => {
  if (!ready || analysisBusy || currentNodeCount === 0 && currentOptions().scope === 'selection') {
    if (currentNodeCount === 0 && currentOptions().scope === 'selection') {
      setStatus('Selecciona al menos un elemento para exportar.');
    }
    return;
  }
  exportButton.disabled = true;
  setStatus('Generando el archivo JSON…');
  post('EXPORT');
});

post('READY', { options: currentOptions() });

