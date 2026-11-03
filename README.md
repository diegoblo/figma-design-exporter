# Figma Design Exporter

Plugin de desarrollo para Figma Desktop que exporta propiedades de diseño a un JSON local, versionado y consultable por asistentes de IA. No usa backend ni realiza peticiones externas.

## Requisitos

- Figma Desktop actualizado.
- Node.js 22.6 o posterior y npm.

## Instalación y desarrollo

```bash
npm install
npm run typecheck
npm test
npm run build
```

En Figma Desktop, abre un archivo y elige **Plugins → Development → Import plugin from manifest…**. Selecciona el `manifest.json` de este proyecto. Después ejecuta **Plugins → Development → Figma Design Exporter**.

El manifest usa `id: "0"` para desarrollo local. Si Figma asigna un identificador al crear/importar el plugin desde su asistente, conserva el identificador que Figma genere en tu copia local del manifest.

Cada vez que cambies el código, vuelve a ejecutar `npm run build` y relanza el plugin desde el menú de desarrollo.

## Uso

1. Selecciona uno o varios nodos o elige **Página actual**.
2. Ajusta si se expanden las capas internas de instancias/componentes y si se incluyen nodos ocultos.
3. Comprueba el número de nodos y el tamaño calculado.
4. Pulsa **Exportar JSON**. Figma descarga el archivo desde la interfaz local del plugin.

El botón **Actualizar** vuelve a leer el documento. Los cambios de selección, página, nodos y estilos invalidan la vista previa automáticamente. El archivo exportado es una instantánea del estado que se mostró en la vista previa.

## Estructura del JSON

- `schemaVersion`: versión del formato, actualmente `1.0.0`.
- `document`, `roots`, `nodes`: metadatos y jerarquía. `nodes` es un diccionario por ID; cada nodo guarda `parentId` y los `childIds` en orden de Figma (de atrás hacia delante).
- `geometry`, `layout`, `appearance`, `text`: propiedades que la API expone para cada tipo de nodo. Los campos que no existen para ese nodo se omiten.
- `styles.paints`, `styles.effects`, `styles.text`: diccionarios deduplicados. Los nodos y los fragmentos de texto los referencian por `ref`/`styleRef`.
- `styles.local`: estilos de Figma referenciados por los nodos exportados.
- `tokens.variables`, `tokens.collections`: variables alcanzables desde las vinculaciones exportadas y sus colecciones/modos. `resolvedVariables` en cada consumidor conserva el valor efectivo que Figma resuelve y, cuando es posible, el modo explícito o heredado que lo originó.
- `components`: metadatos de definiciones enlazadas a instancias. La jerarquía completa de una definición aparece en `nodes` solo si está dentro del alcance exportado.
- `stats.errors`: errores de lectura individuales. Un error en un nodo o propiedad no detiene el resto de la exportación.

Los valores numéricos proceden directamente de la API y se conservan sin redondear. En colores se mantienen los canales originales presentes (`r/g/b` y `a` cuando la API la devuelve); `hex`, `hex8`, `rgb` y `rgba` son representaciones derivadas. No se añade alfa cuando el dato original no lo contiene. Los índices de fragmentos de texto son offsets UTF-16, igual que en la API de Figma.

El archivo de esquema JSON está en [`schema/export.schema.json`](schema/export.schema.json), los tipos TypeScript en [`src/exporter/schema.ts`](src/exporter/schema.ts) y un ejemplo en [`examples/landing-page.json`](examples/landing-page.json).

## Capacidades y límites de la API

El proyecto se basa en las [tipificaciones oficiales de Figma](https://github.com/figma/plugin-typings) y en la [referencia oficial de la Plugin API](https://developers.figma.com/docs/plugins/api/api-reference/). El manifest declara `documentAccess: "dynamic-page"`, requerido en plugins nuevos. Solo se carga la página activa. El código usa versiones asíncronas de la API para resolver estilos y variables y no recorre otras páginas.

La API permite leer jerarquía, estado visible/bloqueado, geometría, propiedades de Auto Layout, paints, efectos, texto y rangos con estilos mixtos, referencias a estilos, variables vinculadas, modos y overrides directos de instancias. Las propiedades se consultan de forma defensiva; si una no está disponible o falla, no se inventa un valor y se registra el error cuando la API devuelve una excepción.

Limitaciones importantes:

- La API no marca de forma general si una propiedad es explícita, heredada o calculada. El plugin incluye overrides directos de instancias cuando están disponibles y etiqueta geometría absoluta entregada por Figma como resultado de la API.
- Imágenes y vídeos no se incrustan: se exportan sus metadatos y hashes disponibles, no los bytes del recurso.
- Las definiciones de componentes fuera del alcance se incluyen como metadatos enlazados, no con todos sus descendientes. Para exportar sus capas, inclúyelas en la página o en la selección exportada.
- Los identificadores de estilos o variables que la API no pueda resolver permanecen como referencias en el árbol y se omite el detalle que no esté disponible.
- La exportación solo cubre el contenido local del archivo y la página actual; no importa bibliotecas ni accede a datos del equipo, comentarios o historial de versiones.

Más detalles en la documentación de Figma sobre [carga dinámica de páginas](https://developers.figma.com/docs/plugins/migrating-to-dynamic-loading/), [estilos de texto por rango](https://developers.figma.com/docs/plugins/api/properties/TextNode-getstyledtextsegments/), [variables](https://developers.figma.com/docs/plugins/working-with-variables/) y [manifest](https://developers.figma.com/docs/plugins/manifest/).

## Privacidad

`networkAccess.allowedDomains` se limita a `["none"]`. La generación, el cálculo de tamaño y la descarga se realizan en el proceso local del plugin y su iframe. El JSON no se envía a ningún servidor y no contiene tokens de acceso ni credenciales.

## Pruebas

`npm test` cubre Auto Layout, componentes e instancias, texto con estilos mixtos, variables y modos, gradientes y efectos, nodos ocultos, jerarquías profundas y propiedades ausentes o con errores. Las pruebas usan nodos simulados; la comprobación final de compatibilidad con la aplicación requiere cargar el manifest en Figma Desktop.

