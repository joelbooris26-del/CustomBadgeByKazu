/*
 * Custom Badge by Kazu - Insignias personalizadas.
 *
 * Cada persona se pone insignias A SÍ MISMA (máx. 3). Si inicia sesión con Discord, sus insignias
 * compartidas las ve cualquiera que tenga este plugin; si las borra, desaparecen para todos.
 * Nadie puede poner insignias a otra persona: el servidor verifica quién eres con Discord.
 */

import { addProfileBadge, BadgePosition, ProfileBadge, removeProfileBadge } from "@api/Badges";
import { definePluginSettings } from "@api/Settings";
import { Button } from "@components/Button";
import { Flex } from "@components/Flex";
import { Heading } from "@components/Heading";
import { Margins } from "@components/margins";
import { Paragraph } from "@components/Paragraph";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType, PluginNative } from "@utils/types";
import { chooseFile } from "@utils/web";
import { showToast, TextInput, UserStore, useState } from "@webpack/common";

const MAX_NAME = 20;
const MAX_MINE = 3;
const MAX_GIF_BYTES = 70 * 1024;
const SYNC_DELAY_MS = 1500;
const REFRESH_MS = 10 * 60 * 1000;
const logger = new Logger("CustomBadgeByKazu");

/** Servidor de insignias compartidas (Worker de Cloudflare). */
const SERVER_URL = "https://custom-badge-kazu.ustom-adge-orker.workers.dev";
/** Lista pública de insignias: la sirve GitHub (gratis y sin límite práctico). Se actualiza a los pocos minutos. */
const LIST_URL = "https://raw.githubusercontent.com/joelbooris26-del/CustomBadgeByKazu-data/main/badges.json";
const Native = VencordNative.pluginHelpers.CustomBadgeByKazu as PluginNative<typeof import("./native")> | undefined;

/** Insignia propia del usuario actual (se guarda en sus ajustes). */
interface MyBadge {
    id: string;
    name: string;
    image: string;
    link: string;
    /** Si está en false, solo la ve el propio usuario. */
    shared?: boolean;
}

interface PublicBadge {
    userId: string;
    name: string;
    image: string;
    link: string;
}

/** Insignias incluidas en el plugin: las ve cualquiera que lo tenga instalado. */
const BUILTIN_BADGES: PublicBadge[] = [];

/** UserStore solo existe cuando Discord ya cargó: nunca usarlo al importar el módulo. */
function currentUserId(): string {
    try {
        return UserStore?.getCurrentUser?.()?.id ?? "";
    } catch {
        return "";
    }
}

const makeEntry = (): MyBadge => ({ id: crypto.randomUUID(), name: "", image: "", link: "", shared: true });

/** Convierte enlaces de página de Imgur en enlaces directos y valida el protocolo. */
function normalizeImage(raw: string): string {
    let url = raw.trim();
    if (url.startsWith("data:image/")) return url;
    // Imgur entrega los GIF como vídeo (.mp4/.gifv): el .gif equivalente sí es una imagen animada.
    url = url.replace(/^(https?:\/\/i\.imgur\.com\/[A-Za-z0-9]+)\.(?:mp4|gifv|webm)(\?.*)?$/i, "$1.gif");
    // Las páginas de ImgBB (ibb.co/xxxx) no son la imagen: hace falta el enlace directo (i.ibb.co/...).
    if (/^https?:\/\/(?:www\.)?ibb\.co\//i.test(url)) return "";
    // Un vídeo no se puede mostrar como insignia.
    if (/\.(mp4|webm|mov|gifv)(\?.*)?$/i.test(url)) return "";
    const page = url.match(/^https?:\/\/(?:www\.)?imgur\.com\/(?!a\/|gallery\/)([A-Za-z0-9]+)\/?$/);
    if (page) return `https://i.imgur.com/${page[1]}.png`;
    return /^https:\/\//i.test(url) ? url : "";
}

const normalizeLink = (raw: string) => /^https?:\/\//i.test(raw.trim()) ? raw.trim() : "";

async function fileToBadgeImage(file: File): Promise<string> {
    // Los GIF se guardan tal cual para conservar la animación (el canvas la perdería).
    if (file.type === "image/gif") {
        if (file.size > MAX_GIF_BYTES) throw new Error("GIF demasiado grande");
        return await new Promise<string>((resolve, reject) => {
            const r = new FileReader();
            r.onload = () => resolve(String(r.result));
            r.onerror = reject;
            r.readAsDataURL(file);
        });
    }
    const bmp = await createImageBitmap(file);
    const size = 64;
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext("2d")!;
    const side = Math.min(bmp.width, bmp.height);
    ctx.drawImage(bmp, (bmp.width - side) / 2, (bmp.height - side) / 2, side, side, 0, 0, size, size);
    return canvas.toDataURL("image/png");
}

const settings = definePluginSettings({
    editor: {
        type: OptionType.COMPONENT,
        component: () => <Editor />
    },
    badges: {
        type: OptionType.CUSTOM,
        default: [] as MyBadge[],
        description: "Mis insignias"
    },
    session: {
        type: OptionType.CUSTOM,
        default: "",
        description: "Sesión con el servidor de insignias"
    },
    sessionUser: {
        type: OptionType.CUSTOM,
        default: "",
        description: "Usuario con el que se inició sesión"
    }
});

// ---------------------------------------------------------------- servidor

let remoteBadges: PublicBadge[] = [];
let refreshTimer: ReturnType<typeof setInterval> | undefined;
let syncTimer: ReturnType<typeof setTimeout> | undefined;

async function refreshRemote() {
    if (!Native?.fetchList) return;
    try {
        const res = await Native.fetchList(LIST_URL);
        if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
        const list = JSON.parse(res.data);
        if (!Array.isArray(list)) return;
        remoteBadges = list
            .filter(b => b && /^\d+$/.test(String(b.userId)) && typeof b.name === "string" && typeof b.image === "string")
            .slice(0, 2000)
            .map(b => ({ userId: String(b.userId), name: b.name, image: b.image, link: typeof b.link === "string" ? b.link : "" }));
    } catch (e) {
        logger.warn("No se pudo actualizar la lista compartida", e);
    }
}

/** Envía mis insignias compartidas al servidor (reemplaza las anteriores, así borrar también se propaga). */
async function syncMine() {
    const { session, badges } = settings.store;
    if (!session || !Native?.api) return;

    const list = badges
        .filter(b => b.shared !== false && b.name && normalizeImage(b.image))
        .slice(0, MAX_MINE)
        .map(b => ({ name: b.name.slice(0, MAX_NAME), image: normalizeImage(b.image), link: normalizeLink(b.link) }));

    const res = await Native.api(SERVER_URL, "PUT", "/me/badges", session, JSON.stringify(list));
    if (res.status === 200) {
        refreshRemote();
    } else if (res.status === 401) {
        settings.store.session = "";
        settings.store.sessionUser = "";
        showToast({ text: "Tu sesión caducó. Vuelve a iniciar sesión en los ajustes del plugin.", variant: "critical" });
    } else if (res.status === 403) {
        showToast({ text: "Tu cuenta no puede publicar insignias.", variant: "critical" });
    } else if (res.status === 400) {
        showToast({ text: "Alguna insignia no es válida (imagen demasiado grande o enlace incorrecto).", variant: "critical" });
    } else {
        logger.error("Fallo al sincronizar", res);
        showToast({ text: "No se pudieron publicar tus insignias.", variant: "critical" });
    }
}

const scheduleSync = () => {
    clearTimeout(syncTimer);
    syncTimer = setTimeout(syncMine, SYNC_DELAY_MS);
};

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function randomState() {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function login() {
    if (!Native?.api) return showToast({ text: "Esta función necesita la app de escritorio.", variant: "critical" });
    const state = randomState();
    VencordNative.native.openExternal(`${SERVER_URL}/auth/start?state=${state}`);
    showToast({ text: "Se abrió tu navegador: acepta el inicio de sesión con Discord.", variant: "success" });

    for (let i = 0; i < 90; i++) {
        await sleep(2000);
        const res = await Native.api(SERVER_URL, "GET", `/auth/poll?state=${state}`);
        if (res.status !== 200) continue;
        let data: any;
        try { data = JSON.parse(res.data); } catch { continue; }
        if (!data?.token) continue;

        if (data.userId !== currentUserId()) {
            return showToast({ text: "Iniciaste sesión con otra cuenta de Discord distinta a la de esta app. Inténtalo de nuevo con la misma.", variant: "critical" });
        }
        settings.store.session = data.token;
        settings.store.sessionUser = data.userId;
        showToast({ text: "Sesión iniciada. Tus insignias compartidas ya se publican.", variant: "success" });
        return syncMine();
    }
    showToast({ text: "Se agotó el tiempo para iniciar sesión.", variant: "critical" });
}

async function logout() {
    const { session } = settings.store;
    settings.store.session = "";
    settings.store.sessionUser = "";
    if (session) await Native?.api(SERVER_URL, "DELETE", "/auth/session", session);
    showToast({ text: "Sesión cerrada. Tus insignias dejaron de estar publicadas en este equipo.", variant: "success" });
}

// ------------------------------------------------------------------- editor

function Field({ label, value, placeholder, maxLength, onCommit }: {
    label: string; value: string; placeholder?: string; maxLength?: number; onCommit(v: string): void;
}) {
    const [v, setV] = useState(value);
    return (
        <div style={{ marginBottom: 8 }}>
            <Paragraph weight="medium" size="sm">{label}{maxLength ? ` (${v.length}/${maxLength})` : ""}</Paragraph>
            <TextInput
                value={v}
                placeholder={placeholder}
                maxLength={maxLength}
                spellCheck={false}
                onChange={setV}
                onBlur={() => v !== value && onCommit(v)}
            />
        </div>
    );
}

function Editor() {
    const { badges, session } = settings.use(["badges", "session", "sessionUser"]);
    const atLimit = badges.length >= MAX_MINE;

    return (
        <div>
            <Heading className={Margins.bottom8}>Mis insignias ({badges.length}/{MAX_MINE})</Heading>
            <Paragraph className={Margins.bottom8}>
                Estas insignias son tuyas: solo puedes ponértelas a ti. Para que otras personas con este plugin
                las vean, inicia sesión con Discord (solo se usa para comprobar que eres tú). Si borras una, deja de verse para todos.
            </Paragraph>

            <Flex style={{ gap: 8, alignItems: "center", marginBottom: 16 }}>
                {session
                    ? <>
                        <Paragraph size="sm">Conectado: tus insignias compartidas están publicadas.</Paragraph>
                        <Button variant="dangerPrimary" onClick={logout}>Cerrar sesión</Button>
                    </>
                    : <>
                        <Paragraph size="sm">Sin sesión: solo tú ves tus insignias.</Paragraph>
                        <Button onClick={login}>Iniciar sesión con Discord</Button>
                    </>}
            </Flex>

            <div style={{ border: "1px solid var(--border-subtle, #444)", borderRadius: 8, padding: 12, marginBottom: 16 }}>
                <Paragraph weight="semibold" className={Margins.bottom8}>Cómo poner imágenes y GIFs</Paragraph>
                <Paragraph size="sm">
                    <b>Opción A: Subir archivo.</b> Pulsa "Subir archivo" en tu insignia y elige la imagen.
                    Las fotos se recortan solas. Los GIF animados pueden pesar hasta 70 KB.
                </Paragraph>
                <Paragraph size="sm" className={Margins.top8}>
                    <b>Opción B: enlace (para GIF grandes).</b>
                </Paragraph>
                <Paragraph size="sm">
                    1. Entra en imgbb.com y sube tu imagen o GIF.<br />
                    2. En la página de tu imagen, busca "Direct link" (enlace directo).<br />
                    3. Cópialo: tiene que empezar por <b>https://i.ibb.co/</b> y acabar en <b>.png</b> o <b>.gif</b>.<br />
                    4. Pégalo en el campo "Imagen" y pulsa fuera del campo.
                </Paragraph>
                <Paragraph size="sm" className={Margins.top8}>
                    Ojo: la dirección de la barra del navegador (ibb.co/...) NO sirve, es una página.
                    Los enlaces de Imgur terminados en .mp4 son vídeos y tampoco se pueden animar.
                    Solo se cargan imágenes de ciertas webs: ImgBB (i.ibb.co), Imgur (i.imgur.com), Pinterest y el CDN de Discord.
                </Paragraph>
                <Paragraph size="sm" className={Margins.top8}>
                    Los cambios se ven al reabrir el perfil. Si no, recarga Discord con Ctrl+R.
                </Paragraph>
            </div>

            <Flex flexDirection="column" style={{ gap: 16 }}>
                {badges.map((b, i) => (
                    <div key={b.id} style={{ border: "1px solid var(--border-subtle, #444)", borderRadius: 8, padding: 12 }}>
                        <Flex style={{ gap: 12, alignItems: "center", marginBottom: 8 }}>
                            {normalizeImage(b.image)
                                ? <img src={normalizeImage(b.image)} width={40} height={40} style={{ borderRadius: "50%", objectFit: "cover" }} />
                                : <div style={{ width: 40, height: 40, borderRadius: "50%", background: "var(--background-modifier-hover, #333)" }} />}
                            <Paragraph weight="semibold">{b.name || `Insignia ${i + 1}`}</Paragraph>
                        </Flex>

                        <Field label="Nombre" value={b.name} maxLength={MAX_NAME} placeholder="Texto al pasar el ratón"
                            onCommit={v => { b.name = v.slice(0, MAX_NAME); scheduleSync(); }} />
                        <Field label="Imagen (enlace .png o .gif)" value={b.image.startsWith("data:") ? "" : b.image}
                            placeholder={b.image.startsWith("data:") ? "(imagen subida desde archivo)" : "https://i.imgur.com/..."}
                            onCommit={v => {
                                const img = normalizeImage(v);
                                if (v.trim() && !img) showToast({ text: "Enlace no válido: usa el enlace DIRECTO de la imagen (https://..., acabado en .png o .gif), no una página ni un vídeo. En ImgBB es el que empieza por i.ibb.co.", variant: "critical" });
                                else { b.image = img; scheduleSync(); }
                            }} />
                        <Field label="Enlace al hacer clic (opcional)" value={b.link} placeholder="https://..."
                            onCommit={v => { b.link = normalizeLink(v); scheduleSync(); }} />

                        <label style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8 }}>
                            <input type="checkbox" checked={b.shared !== false}
                                onChange={e => { b.shared = e.target.checked; scheduleSync(); }} />
                            <Paragraph size="sm">Visible para los demás (requiere sesión)</Paragraph>
                        </label>

                        <Flex style={{ gap: 8 }}>
                            <Button onClick={async () => {
                                const file = await chooseFile("image/*");
                                if (!file) return;
                                try {
                                    b.image = await fileToBadgeImage(file);
                                    scheduleSync();
                                    showToast({ text: "Imagen cargada", variant: "success" });
                                } catch (e) {
                                    logger.error("No se pudo leer la imagen", e);
                                    showToast({ text: e instanceof Error && e.message === "GIF demasiado grande" ? "El GIF pesa más de 70 KB" : "No se pudo leer esa imagen", variant: "critical" });
                                }
                            }}>Subir archivo</Button>
                            <Button variant="dangerPrimary" onClick={() => { badges.splice(i, 1); scheduleSync(); }}>Eliminar</Button>
                        </Flex>
                    </div>
                ))}
                <Button
                    disabled={atLimit}
                    onClick={() => badges.push(makeEntry())}
                >
                    {atLimit ? `Límite alcanzado (${MAX_MINE})` : "Añadir insignia"}
                </Button>
            </Flex>
        </div>
    );
}

// ------------------------------------------------------------------ insignias

const container: ProfileBadge = {
    id: "kazu-badges-container",
    position: BadgePosition.START,
    getBadges({ userId }) {
        const me = currentUserId();
        const mine: PublicBadge[] = userId === me
            ? settings.store.badges.map(b => ({ userId: me, name: b.name, image: b.image, link: b.link }))
            : [];

        const out: ProfileBadge[] = [];
        const seen = new Set<string>();
        for (const b of [...BUILTIN_BADGES, ...remoteBadges.filter(r => r.userId !== me), ...mine]) {
            if (b.userId !== userId) continue;
            const image = normalizeImage(b.image);
            if (!b.name || !image) continue;
            const key = `${b.userId}|${b.name}`;
            if (seen.has(key)) continue;
            seen.add(key);

            const link = normalizeLink(b.link);
            out.push({
                id: `kazu-${out.length}-${key}`,
                key: `kazu-${out.length}-${key}`,
                description: b.name.slice(0, MAX_NAME),
                name: b.name.slice(0, MAX_NAME),
                detail: "Insignia personalizada",
                iconSrc: image,
                largeIconSrc: image,
                link: link || undefined,
                props: { style: { borderRadius: "50%" } }
            });
        }
        return out;
    }
};

export default definePlugin({
    name: "CustomBadgeByKazu",
    description: "Custom Badge by Kazu: ponte hasta 3 insignias personalizadas (nombre, imagen o GIF y enlace) que verán los demás usuarios del plugin",
    authors: [{ name: "Kazu", id: 0n }],
    settings,

    start() {
        addProfileBadge(container);

        // Corrige enlaces guardados que eran vídeos de Imgur (.mp4 -> .gif) y los vuelve a publicar.
        let changed = false;
        for (const b of settings.store.badges) {
            const fixed = normalizeImage(b.image);
            if (fixed && fixed !== b.image) { b.image = fixed; changed = true; }
        }
        if (changed) scheduleSync();

        refreshRemote();
        refreshTimer = setInterval(refreshRemote, REFRESH_MS);
    },
    stop() {
        removeProfileBadge(container);
        clearInterval(refreshTimer);
        clearTimeout(syncTimer);
    }
});
