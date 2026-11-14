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

### Dos listas de productos: comercios e instituciones

Cada producto pertenece a una lista (campo `list`): **comercio** (por defecto) o **institucion** (residenciales e instituciones).
Antes de vender, y al entrar a Productos, la app pregunta "¿Comercio o institución?" y muestra solo los productos y precios
de esa lista. Cada venta guarda su lista; en Ventas se puede filtrar por ella. El servidor rechaza una venta que mezcle listas.

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

**Supervisor** (rol nuevo): vende como un vendedor y además ve los clientes, ventas, rutas y visitas de los usuarios de
**sus zonas**, les arma las rutas y les aprueba la comisión. Las zonas se crean en Configuración → Zonas (cada una con su
supervisor) y la zona de cada vendedor se elige en Usuarios → Editar.

Siempre tiene que quedar al menos un administrador activo. Tras 8 intentos fallidos de clave, ese email queda bloqueado 15 minutos.

## 2b. Ventas en terreno (web, pensado para tablet)

| Pantalla | Quién | Qué hace |
|---|---|---|
| **Hoy** | todos (inicio del vendedor) | Ruta del día, próxima visita, check-in / check-out con GPS, ficha del comercio, Vender, resultado de la visita y nota |
| **Rutas** | supervisor, admin | Arma la ruta de cada vendedor por día (repetible semanal), ordena por cercanía, copia de otro día |
| **Jornada** | supervisor, admin | Programadas vs. realizadas, GPS validado, alertas, resultados, ventas, mapa del día y notas |
| **Comisiones** | todos | Cálculo y aprobación; el vendedor solo ve su comisión cuando el supervisor la aprueba |

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
- Colecciones nuevas en `svc_docs`: `zones`, `routes`, `visits`, `commissions`, `profiles`, `audios` (los audios no van
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
