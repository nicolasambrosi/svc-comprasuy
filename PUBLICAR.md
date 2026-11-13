# SVC · Sistema de Ventas Comprasuy

Sitio estático: **todo lo que se publica está en la carpeta `app/`**. No hay que instalar ni compilar nada.

```
app/
  index.html          Landing page (inicio)
  app/                El sistema de ventas (Panel, Nueva venta, Ventas, Productos, Clientes, Reportes, Configuración)
  privacidad/         Política de privacidad (borrador)
  soporte/            Página de ayuda
  assets/             Estilos, logo y config.js (email y WhatsApp de contacto)
```

## 1. Antes de publicar (5 minutos)

1. **`app/assets/config.js`**: poné el email y WhatsApp reales de Comprasuy.
2. **Precios** en `app/index.html` (sección "Planes"): hoy dicen Gratis / $U 990 / A medida como ejemplo.
3. **Privacidad** (`app/privacidad/index.html`): es un borrador; que lo revise alguien de legal.

## 2. Probarlo en tu PC

```bash
node serve.js
```

Abrí http://localhost:5173

## 3. Publicarlo (elegí una opción)

**Netlify (la más fácil, gratis):**
1. Entrá a https://app.netlify.com/drop
2. Arrastrá la carpeta `app` entera.
3. Te da una dirección tipo `algo.netlify.app`. Desde "Domain settings" podés conectar tu dominio (ej. `svc.comprasuy.com`).

**Vercel / Cloudflare Pages / GitHub Pages:** subí la carpeta `app` como sitio estático, sin comando de build. El directorio de salida es `app`.

**Hosting propio (cPanel, etc.):** subí el *contenido* de `app/` a `public_html` por FTP.

## 4. Cómo guarda los datos (importante)

El sistema guarda productos, clientes y ventas **en el navegador de cada equipo** (localStorage):

- Cada computadora o celular tiene sus propios datos; **no se comparten entre equipos ni usuarios**.
- Si se borran los datos del navegador, se pierden. Por eso: **Configuración → Descargar respaldo**, seguido.
- Para pasar los datos a otro equipo: Descargar respaldo → Restaurar respaldo.
- No hay usuarios ni contraseñas.

Esto sirve para un negocio con una sola caja. Para **varios vendedores compartiendo los mismos datos**, con usuario y contraseña, el siguiente paso es agregar un backend (por ejemplo Supabase o Firebase).

## 5. Qué NO hace todavía

- Factura electrónica DGI (CFE): los comprobantes son internos. Requiere un proveedor habilitado.
- El formulario de contacto abre el programa de correo del visitante (mailto). Para recibir los formularios sin eso, podés usar Netlify Forms o Formspree.
