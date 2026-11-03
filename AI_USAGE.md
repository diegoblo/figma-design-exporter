# Cómo usar el JSON con ChatGPT o Codex

El archivo exportado contiene las propiedades que expone la Plugin API y conserva referencias por ID. Para que una implementación mantenga la fidelidad, proporciona el `.json` completo junto con el código fuente al que quieres aplicarlo.

## Flujo recomendado

1. Exporta el frame o la página que contiene la pantalla.
2. Adjunta el JSON a ChatGPT o Codex, o colócalo en el repositorio de tu aplicación.
3. Pide al asistente que consulte los datos por el ID o nombre del nodo antes de escribir código.
4. Indícale el framework, el punto de entrada y las restricciones del proyecto.
5. Pide que señale cualquier dato ausente y que no estime medidas que no figuren en el archivo.

## Prompt inicial

```text
Usa el JSON de Figma adjunto como fuente de verdad para las propiedades del diseño.
El esquema es schemaVersion 1.0.0. Los nodos están indexados en `nodes` por ID,
con `parentId` y `childIds`. Consulta `styles` y `tokens` siguiendo sus referencias.

Antes de implementar:
1. Identifica el nodo raíz y resume su jerarquía y Auto Layout.
2. Enumera las medidas, espaciados, colores, tipografía y efectos disponibles.
3. Señala propiedades ausentes, errores de lectura y limitaciones del archivo.

Después implementa [DESCRIBE LA PANTALLA O CAMBIO] en [FRAMEWORK], dentro de
[ARCHIVOS/PUNTO DE ENTRADA]. Conserva los valores numéricos tal como aparecen,
no inventes valores ausentes y explica qué IDs de nodo usaste para cada sección.
```

## Preguntas para consultar propiedades

```text
¿Qué anchura, altura, padding y gap tiene el nodo con ID `1:23`? Cita el ID y las rutas JSON.
```

```text
Busca en `nodes` el frame llamado “Hero Section”. Devuelve los IDs de sus hijos,
en orden, e indica qué hijos usan layout positioning absoluto.
```

```text
¿Qué estilos mixtos aparecen en el texto del nodo `1:42`? Usa los offsets start/end
y resuelve cada styleRef en `styles.text`.
```

```text
Localiza las variables enlazadas al fill del nodo `1:23`. Devuelve su nombre,
colección, modos, valor por modo y cualquier alias sin resolver.
```

## Lectura correcta de campos

- `nodes[id].geometry.x/y` son coordenadas locales del nodo; `absoluteTransform` y `absoluteBoundingBox` contienen la geometría absoluta que Figma expone.
- `childIds` conserva el orden de capas de Figma de atrás hacia delante. Usa `parentId` para subir por el árbol.
- `appearance.paintRefs` contiene referencias al diccionario `styles.paints`; los valores `hex`/`hex8` y `rgb`/`rgba` son formas de consulta, y los canales que Figma devuelve se conservan. El campo alfa no se añade si falta en la fuente.
- `text.characters` guarda el texto completo. `text.runs` indica rangos UTF-16 y un `styleRef` de `styles.text` para cada fragmento.
- `styleRefs` apunta a `styles.local`; conserva esos IDs si quieres comparar nodos con estilos compartidos.
- `tokens.variables` incluye variables alcanzables por alias desde la selección/página. `valuesByMode` conserva valores directos o alias; los valores de color conservan los canales originales y añaden representaciones hexadecimales.
- `resolvedVariables` en un nodo muestra el valor activo resuelto para ese consumidor. `source` indica `explicit`, `inherited` o `collection-default` cuando Figma expone esa información; `sourceNodeId` localiza el nodo que asignó el modo.
- `components[id]` describe una definición referenciada. Su árbol completo solo estará presente en `nodes` si la definición estaba dentro del alcance exportado.
- `stats.errors` y `limitations` son parte del resultado. Si falta una propiedad, el asistente debe decir que no está disponible en el JSON.

Para comparar un frame completo, exporta **Página actual**. Para preguntas acotadas o para reducir tamaño, exporta solo el frame o componente relevante.
