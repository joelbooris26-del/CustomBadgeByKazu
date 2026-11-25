# Custom Badge by Kazu

Plugin para **Vencord** y **Equicord** que te deja ponerte hasta **3 insignias personalizadas** en el perfil
(nombre, imagen o GIF animado, y un enlace opcional). Las ven todas las personas que tengan el plugin,
da igual si usan Vencord o Equicord.

*English: a Vencord/Equicord userplugin that lets you add up to 3 custom profile badges (name, image or animated
GIF, optional link). Everyone running the plugin sees them, on either client.*

## Cómo funciona

- Cada persona se pone insignias **solo a sí misma**. Nadie puede ponérselas a otra persona.
- Para que los demás las vean hay que **iniciar sesión con Discord** (solo se usa para comprobar quién eres;
  el plugin nunca recibe tu token de Discord ni tu contraseña).
- Si borras una insignia, desaparece para todos (los demás la dejan de ver en unos minutos).
- Sin sesión, tus insignias son solo locales: solo las ves tú.
- Límites: 3 insignias por persona, nombre de máx. 20 caracteres, GIF subidos de máx. 70 KB.
- Imágenes por enlace: `.png` o `.gif` directo (por ejemplo `https://i.imgur.com/abc123.gif`).
  Discord solo carga imágenes de algunas webs (Imgur, ImgBB, Pinterest y el CDN de Discord, entre otras).
  Con otras webs usa **Subir archivo**.

## Instalación fácil (Windows)

1. Descarga [`Instalar.bat`](https://github.com/joelbooris26-del/CustomBadgeByKazu/raw/main/Instalar.bat)
   (botón derecho > *Guardar enlace como*).
2. Haz doble clic. Si Windows avisa de que es un archivo desconocido, pulsa *Más información > Ejecutar de todas formas*.
3. Elige **Vencord** o **Equicord**, elige tu Discord y confirma.

**No necesitas instalar nada más** (ni Node.js ni Git). El instalador descarga Vencord o Equicord ya compilados con el
plugin incluido (los compila GitHub automáticamente, cada día y cada vez que cambia el plugin), usa el instalador
oficial del cliente para parchear tu Discord, activa el plugin y vuelve a abrir Discord. Tarda menos de un minuto.
Todo lo que hace está en [`install.ps1`](install.ps1): puedes leerlo antes de ejecutarlo. Las compilaciones se
pueden revisar en la pestaña *Actions* de este repositorio y se descargan de *Releases*.

- Es seguro ejecutarlo otra vez: sirve para **actualizar** el plugin o para **reinstalarlo** si Discord se actualiza
  y deja de verse.
- Tus ajustes de Vencord/Equicord no se borran.
- Para desinstalar, borra la carpeta `CustomBadgeByKazu-install` de tu usuario y reinstala el cliente normal
  desde su instalador oficial.

Mac y Linux: usa la instalación manual de abajo.

## Instalación manual (avanzado)

Si prefieres compilarlo tú mismo, `install-source.ps1` hace lo mismo pero compilando en tu equipo (necesita
Node.js y Git; los instala con `winget` si faltan). O sigue estos pasos a mano:

Los plugins propios necesitan compilar el cliente desde su código fuente. Necesitas
[Node.js](https://nodejs.org), [Git](https://git-scm.com) y `pnpm` (`npm i -g pnpm`).
En PowerShell, si `npm` da un error de scripts deshabilitados, ejecuta antes
`Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned`.

### Equicord

```powershell
git clone https://github.com/Equicord/Equicord.git
cd Equicord
pnpm install --frozen-lockfile
mkdir src\userplugins\customBadgeByKazu
```

Copia `plugin/customBadgeByKazu/index.tsx` y `plugin/customBadgeByKazu/native.ts` a
`src\userplugins\customBadgeByKazu\`. Después, con Discord **cerrado**:

```powershell
pnpm build
pnpm inject
```

### Vencord

Igual, con `https://github.com/Vendicated/Vencord.git`.

Al terminar, abre Discord y ve a **Ajustes > Plugins > Custom Badge by Kazu** y actívalo.
Para actualizar el plugin: sustituye los archivos, `pnpm build` y recarga Discord con Ctrl+R.

> Los ajustes se conservan. Si tu Discord se actualiza y se pierde el parche, repite `pnpm inject`.

## Uso

1. En los ajustes del plugin pulsa **Iniciar sesión con Discord** y acepta en el navegador.
2. **Añadir insignia**, pon nombre e imagen. Se publica sola.
3. Los demás la ven al reabrir tu perfil.

## El servidor

Funciona con dos piezas, las dos gratis:

- Un **Worker de Cloudflare** (carpeta `server/`) que solo se usa para iniciar sesión y publicar. Cada pocos
  minutos sube la lista de insignias a un archivo `badges.json` de un repositorio público de GitHub.
- Los demás clientes **leen la lista desde GitHub** (`raw.githubusercontent.com`), que aguanta cualquier
  cantidad de lectores sin coste. Por eso los cambios tardan unos minutos en verse.

El plugin usa las direcciones `SERVER_URL` y `LIST_URL` de `index.tsx`. Si quieres alojar el tuyo:

1. Crea una aplicación en <https://discord.com/developers/applications>. En OAuth2 > Redirects añade
   `https://TU-WORKER.workers.dev/auth/callback`.
2. En `server/` ejecuta `npx wrangler kv namespace create BADGES` y copia el `id` en `wrangler.toml`.
3. Crea un repositorio público de GitHub para los datos (con un README para que tenga rama `main`) y un
   **token de acceso fino** (Settings > Developer settings > Fine-grained tokens) limitado a ese único
   repositorio, con el permiso *Contents: Read and write*.
4. Rellena `DISCORD_CLIENT_ID` y `GITHUB_REPO` en `wrangler.toml`, y guarda los secretos:
   `npx wrangler secret put DISCORD_CLIENT_SECRET`, `npx wrangler secret put ADMIN_KEY`
   y `npx wrangler secret put GITHUB_TOKEN`.
5. `npx wrangler deploy`, y cambia `SERVER_URL` y `LIST_URL` en `index.tsx` por tus direcciones.

Moderación: con tu `ADMIN_KEY` puedes quitar las insignias de alguien (y vetarle) con
`POST /admin/remove` y el cuerpo `{"userId":"123...","ban":true}`.

## Privacidad

El servidor guarda, por cada insignia publicada: tu ID de usuario de Discord (público), el nombre, la imagen y el
enlace. Del inicio de sesión solo conserva un token aleatorio de sesión (en forma de hash). No guarda tu token
de Discord: se revoca nada más identificarte. Cerrar sesión borra tu sesión; borrar tus insignias las elimina.

## Licencia

GPL-3.0-or-later (ver `LICENSE`).
