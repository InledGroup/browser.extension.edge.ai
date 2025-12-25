# Edge.AI Browser Extension

Extensión de navegador para realizar búsquedas automáticas y extracción de contenido web para el sistema de IA Edge.AI.

## Características

- 🔍 **Búsqueda Automática**: Realiza búsquedas en Wikipedia y DuckDuckGo Lite
- 📄 **Extracción de Contenido**: Extrae texto visible y limpio de páginas web
- 🎯 **Procesamiento en Background**: Abre páginas en segundo plano sin interrumpir
- 🔄 **Comunicación con Web App**: Integración completa con la aplicación web Edge.AI
- 💾 **Almacenamiento Local**: Guarda resultados temporalmente para procesamiento posterior

## Instalación

### Chrome/Edge

1. Abre Chrome/Edge y ve a `chrome://extensions/` o `edge://extensions/`
2. Activa el "Modo de desarrollador" (Developer mode)
3. Haz clic en "Cargar extensión sin empaquetar" (Load unpacked)
4. Selecciona la carpeta `browser-extension`
5. Copia el **Extension ID** que aparece en la tarjeta de la extensión

### Firefox

1. Abre Firefox y ve a `about:debugging#/runtime/this-firefox`
2. Haz clic en "Cargar complemento temporal" (Load Temporary Add-on)
3. Selecciona el archivo `manifest.json` en la carpeta `browser-extension`

## Configuración en Edge.AI

Después de instalar la extensión, configura Edge.AI con el Extension ID:

```typescript
import { createWebResearch } from './src/lib/web-research';

const webResearch = createWebResearch({
  extensionId: 'TU_EXTENSION_ID_AQUI', // Pega el ID de la extensión
  enableAutoResearch: true,
  maxSourcesPerQuery: 3
});
```

## Uso desde la Web App

### Búsqueda Básica

```typescript
import { getExtensionBridge } from './src/lib/extension-bridge';

const bridge = getExtensionBridge({
  extensionId: 'TU_EXTENSION_ID'
});

// Realizar búsqueda
const results = await bridge.search('machine learning fundamentals');

console.log(`Encontrados ${results.sources.length} resultados`);
results.sources.forEach(source => {
  console.log(`- ${source.title}: ${source.wordCount} palabras`);
});
```

### Búsqueda con Progreso

```typescript
const results = await bridge.searchWithPolling(
  'quantum computing basics',
  (status, count) => {
    console.log(`Estado: ${status}, Fuentes: ${count}`);
  }
);
```

### Integración con RAG

```typescript
import { createWebResearch } from './src/lib/web-research';
import { HybridRAG } from '../hybrid-rag';

// Inicializar RAG
const rag = new HybridRAG(/* config */);

// Crear investigador web
const research = createWebResearch({
  extensionId: 'TU_EXTENSION_ID'
});

research.setRAGSystem(rag);

// Realizar investigación con procesamiento RAG automático
const result = await research.research('artificial intelligence ethics', true);

// Los resultados están ordenados por relevancia
result.sources.forEach(source => {
  console.log(`${source.title} (relevancia: ${source.relevanceScore})`);
});
```

### Con Actualizaciones de Progreso

```typescript
const result = await research.researchWithProgress(
  'neural networks',
  (status, count) => {
    if (status === 'processing') {
      console.log(`Procesando... ${count} fuentes encontradas`);
    } else if (status === 'processing_rag') {
      console.log('Procesando con RAG...');
    } else if (status === 'completed') {
      console.log(`Completado con ${count} fuentes`);
    }
  },
  true // Procesar con RAG
);
```

## Arquitectura

```
┌─────────────────────────────────────────────────────────────┐
│                        Web App (Astro)                       │
│  ┌────────────────────────────────────────────────────────┐ │
│  │              Web Research Module                        │ │
│  │  • research()                                          │ │
│  │  • researchWithProgress()                              │ │
│  │  • Integración con RAG                                 │ │
│  └──────────────────┬──────────────────────────────────────┘ │
│                     │                                         │
│  ┌──────────────────▼──────────────────────────────────────┐ │
│  │           Extension Bridge                              │ │
│  │  • search()                                            │ │
│  │  • searchWithPolling()                                 │ │
│  │  • formatForRAG()                                      │ │
│  └──────────────────┬──────────────────────────────────────┘ │
└────────────────────┼──────────────────────────────────────────┘
                     │ chrome.runtime.sendMessage()
                     │
┌────────────────────▼──────────────────────────────────────────┐
│                  Browser Extension                             │
│  ┌──────────────────────────────────────────────────────────┐ │
│  │         Background Service Worker                         │ │
│  │  • Recibe requests de búsqueda                           │ │
│  │  • Ejecuta búsquedas en Wikipedia y DuckDuckGo          │ │
│  │  • Abre páginas en background tabs                       │ │
│  │  • Coordina extracción de contenido                     │ │
│  │  • Almacena y devuelve resultados                       │ │
│  └──────────────────┬──────────────────────────────────────┘ │
│                     │                                         │
│  ┌──────────────────▼──────────────────────────────────────┐ │
│  │            Content Script                                │ │
│  │  • Se inyecta en cada página abierta                    │ │
│  │  • Extrae contenido principal visible                   │ │
│  │  • Limpia y normaliza texto                             │ │
│  │  • Envía datos al background worker                     │ │
│  └──────────────────────────────────────────────────────────┘ │
└───────────────────────────────────────────────────────────────┘
```

## Flujo de Datos

1. **Web App** envía query a Extension Bridge
2. **Extension Bridge** envía mensaje al Background Service Worker
3. **Background Worker** realiza búsquedas en Wikipedia y DuckDuckGo Lite
4. **Background Worker** abre hasta 3 URLs relevantes en tabs de background
5. **Content Script** se ejecuta automáticamente en cada tab
6. **Content Script** extrae contenido visible y lo envía al Background Worker
7. **Background Worker** recolecta todos los resultados
8. **Background Worker** envía resultados de vuelta a Extension Bridge
9. **Web Research Module** (opcional) procesa con RAG para embeddings
10. **Web App** recibe datos estructurados listos para usar

## Estructura de Datos

### SearchResponse

```typescript
{
  searchId: string;
  query: string;
  timestamp: number;
  status: 'processing' | 'completed' | 'failed';
  sources: [
    {
      url: string;
      title: string;
      content: string;        // Texto limpio extraído
      extractedAt: number;
      wordCount: number;
    }
  ];
  completedAt?: number;
}
```

### ResearchResult (con RAG)

```typescript
{
  query: string;
  sources: [
    {
      title: string;
      url: string;
      content: string;
      relevanceScore?: number;  // Score de RAG
    }
  ];
  timestamp: number;
}
```

## Extracción de Contenido

El content script usa múltiples estrategias para extraer el contenido principal:

1. **Semantic HTML**: Busca elementos `<main>`, `<article>`, `[role="main"]`
2. **Wikipedia Específico**: Extrae de `#mw-content-text`
3. **Limpieza Inteligente**: Elimina navegación, ads, sidebars, footers
4. **Solo Texto Visible**: Ignora elementos ocultos con CSS
5. **Normalización**: Limpia espacios y caracteres especiales

## Límites y Restricciones

- **Máximo 3 páginas** por búsqueda (configurable en background.js)
- **Timeout de 30 segundos** por página
- **Resultados almacenados por 1 hora** en chrome.storage.local
- **Limpieza automática** cada 5 minutos

## Desarrollo

### Modificar comportamiento

**Cambiar número de páginas a abrir:**

```javascript
// En background.js
const MAX_PAGES_PER_SEARCH = 5; // Cambiar de 3 a 5
```

**Cambiar timeout de extracción:**

```javascript
// En background.js, función openAndExtractContent
const timeout = setTimeout(() => {
  // ...
}, 60000); // Cambiar de 30000 a 60000 (60 segundos)
```

**Mejorar extracción de contenido:**

```javascript
// En content.js, añadir más selectores
const mainSelectors = [
  'main',
  'article',
  '#tu-selector-personalizado',
  // ...
];
```

### Debugging

1. **Background Worker**: Ve a `chrome://extensions/` → Click en "Service Worker"
2. **Content Script**: Abre DevTools en cualquier página
3. **Mensajes**: Los logs usan prefijo `[EdgeAI]` para fácil filtrado

## Permisos

La extensión requiere:

- `tabs`: Para crear y gestionar tabs en background
- `storage`: Para almacenar resultados temporalmente
- `scripting`: Para inyectar content scripts
- `host_permissions`: Para acceder a Wikipedia, DuckDuckGo y contenido de páginas

## Seguridad y Privacidad

- ✅ Todo el procesamiento es local
- ✅ No envía datos a servidores externos
- ✅ Solo comunica con localhost (tu web app)
- ✅ Limpia datos antiguos automáticamente
- ✅ No rastrea ni almacena historial de navegación

## Troubleshooting

### La extensión no se comunica con la web app

1. Verifica que el Extension ID esté configurado correctamente
2. Asegúrate de que la web app esté en `http://localhost:*`
3. Revisa la consola del Service Worker para errores

### No se extraen resultados

1. Verifica que los sitios no bloqueen la extensión
2. Aumenta el timeout si las páginas cargan lento
3. Revisa logs en DevTools → Console

### DuckDuckGo no devuelve resultados

- DuckDuckGo Lite puede cambiar su estructura HTML
- Verifica la función `extractUrlsFromDDGLite()` en background.js
- Considera usar la API de DuckDuckGo si está disponible

## Contribuir

Al mejorar la extensión:

1. Mantén la compatibilidad con el manifest v3
2. Añade logs con prefijo `[EdgeAI]`
3. Documenta cambios en este README
4. Prueba en Chrome, Edge y Firefox

## Licencia

Ver LICENSE en el directorio raíz del proyecto.
