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

## 2. Usuarios y roles

En **Configuración → Usuarios** (solo administradores) se crean, editan, desactivan o borran usuarios.

| | Administrador | Vendedor |
|---|---|---|
| Registrar ventas y clientes | ✓ | ✓ |
| Ver ventas | todas | solo las suyas |
| Cambiar estado de una venta | ✓ | ✓ (las suyas) |
| Anular ventas (devuelve stock) | ✓ | — |
| Productos, precios, costos, stock | ✓ | solo ver (sin costos) |
| Borrar clientes | ✓ | — |
| Usuarios, datos de la empresa, respaldo | ✓ | — |
| Cambiar su propia contraseña | ✓ | ✓ |

Siempre tiene que quedar al menos un administrador activo. Tras 8 intentos fallidos de clave, ese email queda bloqueado 15 minutos.

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
