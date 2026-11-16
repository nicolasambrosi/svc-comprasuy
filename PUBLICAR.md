# SVC · Sistema de Ventas Comprasuy

Sitio + sistema de ventas con **base de datos MySQL**, usuarios y roles. Corre como Web App de Node.js en Hostinger.

```
serve.js              Servidor (entrada de la Web App en Hostinger)
server/               API, login/usuarios y acceso a la base de datos
app/
  index.html          Landing page (inicio)
  app/                El sistema de ventas (login, Panel, Nueva venta, Ventas, Productos, Clientes, Reportes, Configuración)
  privacidad/         Política de privacidad (borrador)
  soporte/            Página de ayuda
  assets/             Estilos, logo y config.js (email y WhatsApp de contacto)
```

## 1. Base de datos y variables en Hostinger

En hPanel → **Bases de datos → Administración** se crea una base MySQL. Después, en la Web App
**svc.comprasuy.com → Variables de entorno**, se cargan:

| Variable | Valor |
|---|---|
| `DB_HOST` | `localhost` (o el host que muestra hPanel) |
| `DB_PORT` | `3306` |
| `DB_NAME` | nombre de la base (ej. `u943125021_svc`) |
| `DB_USER` | usuario de la base |
| `DB_PASSWORD` | contraseña de la base |
| `INITIAL_ADMIN_EMAIL` | email del primer administrador |
| `INITIAL_ADMIN_PASSWORD` | su contraseña (mín. 8 caracteres) |

- Al arrancar, el servidor crea solo la tabla `svc_docs` y, si no hay ningún administrador, crea el inicial con esas dos variables.
- **Las contraseñas nunca van en el código** (el repo es público). Las de los usuarios se guardan cifradas (scrypt).
- Una vez creado el administrador, la contraseña se cambia desde la app (Configuración → Mi contraseña);
  cambiar `INITIAL_ADMIN_PASSWORD` después no tiene efecto.

### Listas de productos: comercios, instituciones y REMAR

Cada producto pertenece a una lista (campo `list`): **comercio** (por defecto) o **institucion** (residenciales e instituciones).
Antes de vender, y al entrar a Productos, la app pregunta "¿Comercio o institución?" y muestra solo los productos y precios
de esa lista. Cada venta guarda su lista; en Ventas se puede filtrar por ella. El servidor rechaza una venta que mezcle listas.

La lista **remar** (REMAR) es privada: solo la ven los administradores. El servidor no manda sus productos ni sus ventas
a supervisores ni vendedores, y solo un administrador puede vender con ella.

**Importar productos (CSV):** en Productos, un administrador elige la lista y toca "Importar CSV" (columnas Codigo, Nombre, Categoria,
Costo, Precio, IVA, Stock, StockMinimo; separador ; o , y decimales con coma). Si el código ya está en esa lista se actualiza;
las columnas que no vienen quedan como estaban. El mismo código puede repetirse en listas distintas.
Columna opcional **Imagen** con la dirección https de una foto: el servidor la baja (GET /api/images/fetch, solo admin,
hasta 8 MB), el navegador la achica y la sube al producto.

**Duplicar venta:** en el comprobante de una venta (botón "Duplicar venta") o en el carrito, al elegir un cliente
("Repetir su última venta"), se copia la venta al carrito con los precios y el stock de hoy, para revisarla y guardarla como venta nueva.

### Catálogos iniciales

- `seed/catalogo-comprasuy.json`: los 172 productos de catalogo.treinta.co/comprasuycomercios (lista comercio).
- `seed/catalogo-instituciones.json`: los 152 productos de catalogo.treinta.co/comprasuyresidenciales (lista institución),
  categorías ALIMENTOS y LIMPIEZA. Se dejó afuera a propósito la categoría "Precio por Mayor".

Cada uno se carga solo **una vez**, al arrancar (queda marcado en la configuración). El IVA se cargó en 22% para todos: revisá los que lleven 10%.

Las imágenes de productos se guardan en la base (colección `images`) y se sirven en `/api/images/<id>`.

## 2. Usuarios y roles

En **Configuración → Usuarios** (solo administradores) se crean, editan, desactivan o borran usuarios.

| | Administrador | Vendedor |
|---|---|---|
| Registrar ventas y clientes | ✓ | ✓ |
| Ver ventas | todas | solo las suyas |
| Ver clientes y venderles | todos | solo los asignados a él |
| Asignar clientes a vendedores | ✓ (Clientes → tildar → Asignar a…) | — |
| Cambiar estado de una venta | ✓ | ✓ (las suyas) |
| Anular ventas (devuelve stock) | ✓ | — |
| Productos, precios, costos, stock | ✓ | solo ver (sin costos) |
| Borrar clientes | ✓ | — |
| Usuarios, datos de la empresa, respaldo | ✓ | — |
| Cambiar su propia contraseña | ✓ | ✓ |

Cada cliente tiene un **vendedor asignado** (campo `sellerId` en la base). El cliente que crea un vendedor queda a su nombre;
los que crea un administrador quedan sin asignar salvo que elija uno. Los clientes sin asignar solo los ven los administradores.
Si se borra un usuario, sus clientes quedan sin asignar.

**Supervisor** (rol nuevo): vende como un vendedor y además ve los clientes, ventas, rutas y visitas de **los vendedores
que tiene a cargo**, les arma las rutas y les aprueba la comisión. Cada vendedor tiene **un supervisor** (Usuarios → Editar
→ Supervisor; campo `supervisorId`). Las **zonas** (Configuración → Zonas, cada una con su supervisor) agrupan comercios:
el supervisor de una zona maneja sus comercios y recorridos, aunque los visite un vendedor de otro supervisor.
Al pasar a este esquema, cada vendedor tomó como supervisor al de la zona que tenía cargada.
Un supervisor con vendedores a cargo no puede cambiar de rol hasta que se les asigne otro; si se lo borra, quedan sin supervisor.

Siempre tiene que quedar al menos un administrador activo. Tras 8 intentos fallidos de clave, ese email queda bloqueado 15 minutos.

### Pagos de comisiones

En Comisiones, un administrador registra los pagos de cada comisión aprobada (monto, fecha, forma de pago y nota; puede
haber pagos parciales). Se guardan en la colección `compays`. El vendedor ve los pagos de su comisión. No se puede quitar
la aprobación de una comisión que ya tiene pagos (primero se borran los pagos).

### Entregas (logística y choferes)

Roles nuevos: **Logística** (camiones, rutas de entrega y estadísticas) y **Chofer** (Mis entregas). Ninguno de los dos ve
ventas, clientes, productos ni comisiones fuera de sus pantallas.

- Cada venta puede llevar entrega: día, turno (mañana/tarde) y camión (o "lo asigna Logística"). Con cliente se programa
  sola para el próximo día hábil. Se cambia desde el comprobante ("Cambiar entrega").
- Logística (menú Logística) elige día y turno, reparte las entregas entre camiones, junta las ventas del mismo cliente en
  una parada, ordena con "Armar mejor ruta" (vecino más cercano + 2-opt desde el depósito) y guarda: el chofer la recibe.
- El chofer (Mis entregas) toca "Empezar ruta" (aviso "en camino" al vendedor y a los administradores), marca cada
  parada entregada (y el cobro: la venta pendiente pasa a cobrada) o no entregada (vuelve a pendiente para reprogramar).
- Km: GPS del celular del chofer mientras la ruta está en curso (si no hubo GPS, la estimación de la ruta). Tiempo: de
  "Empezar ruta" a la última parada. Promedios por camión en Logística → Kilómetros y tiempos.
- Avisos (🔔 en el menú): dentro del sistema, se revisan cada minuto. Colecciones: `trucks`, `delivroutes`, `notices`.

## 2b. Ventas en terreno (web, pensado para tablet)

| Pantalla | Quién | Qué hace |
|---|---|---|
| **Hoy** | todos (inicio del vendedor) | Ruta del día, próxima visita, check-in / check-out con GPS, ficha del comercio, Vender, resultado de la visita y nota |
| **Recorridos** | supervisor, admin | Recorridos fijos por zona (lista ordenada de comercios), asignados a un vendedor y a días de la semana |
| **Rutas** | supervisor, admin | Ruta de cada vendedor por día: sale sola de sus recorridos y se puede cambiar un día puntual (repetible semanal), ordenar por cercanía, copiar de otro día |
| **Jornada** | supervisor, admin | Programadas vs. realizadas, GPS validado, alertas, resultados, ventas, mapa del día y notas |
| **Comisiones** | todos | Cálculo y aprobación; el vendedor solo ve su comisión cuando el supervisor la aprueba |

- **Zonas y recorridos** (orden de trabajo):
  1. Configuración → Zonas: crear las zonas (barrios o áreas) con su supervisor.
  2. Clientes → filtro "Sin zona", tildar comercios → "Poner en zona…" (o editar el cliente → Zona).
  3. Recorridos → Nuevo recorrido: nombre, zona, comercios en orden de visita (ordenar por cercanía, mapa),
     vendedor y días de la semana. Al guardar, los comercios del recorrido quedan **asignados a ese vendedor**
     (avisa antes si alguno era de otro) y los que no tenían zona toman la del recorrido.
  4. Cada día, la ruta del vendedor es la suma de sus recorridos de ese día. En Rutas se cambia un día puntual
     (eso manda sobre el recorrido; "Vaciar" deja ese día sin visitas).
  El supervisor ve y maneja los comercios de las zonas que supervisa, aunque todavía no tengan vendedor.
- **Comercios nuevos (prospectos)**: Recorridos → en cada zona, "🔎 Buscar comercios nuevos". Se elige rubro (almacén,
  kiosco, panadería, carnicería, verdulería, bebidas, farmacia, gastronomía, residenciales, colegios, salud), se acerca el
  mapa a la zona (máx. ~6 km de lado) y "Buscar en esta área". Busca en **OpenStreetMap** (Overpass API; gratis, datos
  © colaboradores de OpenStreetMap, licencia ODbL) y marca cada uno: nuevo, ya es cliente (por nombre y cercanía),
  ya agregado o posible duplicado. Los tildados entran como clientes **Prospecto** en la zona, ubicados y sin vendedor;
  se suman a un recorrido como cualquier comercio y el vendedor los ve marcados "nuevo" en Hoy. Con la **primera venta**
  pasan a cliente (queda `convertedAt`). "Ocultar" evita que uno vuelva a salir. La búsqueda puede tardar hasta un minuto
  (el servidor público de OpenStreetMap a veces está saturado; se reintenta con otro). No están todos los comercios y casi
  nunca traen teléfono. **No se usa Google Maps**: sus condiciones no permiten copiar ni guardar sus comercios.
  En Clientes, el filtro "Solo prospectos" los lista.
- **GPS**: el check-in vale si el vendedor está a menos del radio (Configuración, 100 m por defecto) del comercio.
  Si está lejos o sin GPS **se registra igual** y queda marcado para el supervisor (no bloquea). Requiere HTTPS y que el
  navegador tenga permiso de ubicación. Recomendado: tablets con GPS (con chip de datos); las solo-WiFi ubican mal en la calle.
- **Ubicación de los comercios** (combinada): Configuración → "Ubicar clientes desde su dirección" los ubica de forma
  aproximada con OpenStreetMap (solo acepta resultados a nivel calle/edificio). En la **primera visita** con buen GPS
  (±50 m) y a menos de 1 km, la ubicación se corrige con la del vendedor. Un comercio sin ubicar se ubica en su primer
  check-in. En Jornada el supervisor puede usar un check-in como ubicación del comercio.
- **Comisiones**: % sobre el **neto** (sin IVA, con descuento) de las ventas **cobradas** en el mes (estado pagada o
  entregada, por fecha de cobro `paidAt`); mismo % para comercios e instituciones. El supervisor tiene su % sobre sus
  ventas y otro % sobre lo cobrado por su equipo. Los % se cargan en Usuarios → Editar. La aprobación guarda una foto
  del monto; si después cambia (p. ej. se cobra una venta), se marca "cambió desde la aprobación".
- **Perfil del negocio** (botón en la ficha de la visita, en Clientes → Perfil y en Jornada): tipo de negocio, tamaño,
  exhibición, competencia presente (las marcas que carga el equipo quedan como sugerencia), categorías de interés,
  días y horario de atención, notas y hasta 12 fotos (fachada / góndola / otra, con la cámara de la tablet, achicadas a
  1280 px). Cada cambio guarda la versión anterior ("Cambios anteriores"). En Jornada se ve qué visitas actualizaron perfil.
  Un vendedor solo puede borrar las fotos que sacó él.
- **Notas de audio y coaching**: al cerrar la visita el vendedor puede grabar hasta 3 audios de 2 min (micrófono del
  navegador, ~32 kbps, máx. 3 MB) y **dictar** la nota escrita (reconocimiento de voz del navegador, es-UY; en Chrome el
  audio del dictado lo procesa el servicio de voz del navegador). En Jornada el supervisor escucha, marca la visita como
  revisada y deja un comentario; el vendedor lo ve arriba en Hoy hasta que toca "Entendido".
  **Transcripción automática de los audios con IA: no está activada.** La API de Claude no recibe audio, así que haría
  falta un servicio de voz a texto aparte (cuenta, costo por minuto y clave en las variables de entorno); después Claude
  podría resumir la transcripción en campos (resultado, objeciones, competencia, próximo paso).
- "Cómo llegar" y WhatsApp abren siempre en la misma pestaña aparte (no una nueva por cada toque) y las fotos del
  perfil se ven en grande dentro de la app.
- Colecciones nuevas en `svc_docs`: `zones`, `recorridos`, `osmskip` (comercios de OpenStreetMap ocultados), `routes`, `visits`, `commissions`, `profiles`, `audios` (los audios no van
  en el respaldo descargable). El respaldo (Configuración →
  Descargar respaldo) las incluye; "Restaurar respaldo" no las toca.

## 3. Probarlo en tu PC

```bash
npm install
```

```bash
npm start
```

Abrí http://localhost:5173. Sin variables `DB_*` usa un archivo local (`data/svc-dev.json`) en lugar de MySQL.
Para tener un admin local, creá un archivo `.env` (no se sube a git) con `INITIAL_ADMIN_EMAIL` e `INITIAL_ADMIN_PASSWORD`.

## 4. Dónde está publicado

- **Sitio en vivo:** https://svc.comprasuy.com (Web App de Node.js en Hostinger, archivo de entrada `serve.js`).
- **Repo que despliega Hostinger:** `github.com/nambrosi-Proyectos/svc-comprasuy` (privado, copia hecha por Hostinger).
- **Repo original:** `github.com/nicolasambrosi/svc-comprasuy` (público).

Para publicar un cambio: subilo al repo `nambrosi-Proyectos/svc-comprasuy` (Hostinger redespliega solo),
o en hPanel → svc.comprasuy.com → Despliegues → Redesplegar.

## 5. Antes de usarlo en serio

1. **Precios** en `app/index.html` (sección "Planes"): hoy dicen Gratis / $U 990 / A medida como ejemplo.
2. **Privacidad** (`app/privacidad/index.html`): es un borrador; que lo revise alguien de legal.
3. Descargá un respaldo cada tanto (Configuración → Descargar respaldo), además de los backups de Hostinger.

## 6. Qué NO hace todavía

- Factura electrónica DGI (CFE): los comprobantes son internos. Requiere un proveedor habilitado.
- Recuperar contraseña por email: si alguien la olvida, un administrador le pone una nueva.
- El formulario de contacto abre el programa de correo del visitante (mailto).
