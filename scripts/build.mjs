import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('../', import.meta.url));
const dist = new URL('../dist/', import.meta.url);
const source = fileURLToPath(new URL('../src/', import.meta.url));

await mkdir(dist, { recursive: true });

const [pluginBundle, uiBundle] = await Promise.all([
  build({
    entryPoints: [`${source}/main.ts`],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2020',
    write: false,
    legalComments: 'none'
  }),
  build({
    entryPoints: [`${source}/ui.ts`],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2020',
    write: false,
    legalComments: 'none'
  })
]);

const htmlTemplate = await readFile(`${source}/ui.html`, 'utf8');
const uiScript = new TextDecoder().decode(uiBundle.outputFiles[0].contents);
const html = htmlTemplate.replace('<!-- UI_BUNDLE -->', `<script>${uiScript}</script>`);

if (html.includes('<!-- UI_BUNDLE -->')) {
  throw new Error('No se pudo insertar el bundle de la interfaz en ui.html.');
}

await Promise.all([
  writeFile(new URL('code.js', dist), pluginBundle.outputFiles[0].contents),
  writeFile(new URL('ui.html', dist), html)
]);

console.log(`Plugin compilado desde ${root} a ${fileURLToPath(dist)}`);
