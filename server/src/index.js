// Worker de Cloudflare para Custom Badge by Kazu.
//
// Cada persona solo puede gestionar SUS PROPIAS insignias: su identidad se verifica con
// "Iniciar sesión con Discord" (OAuth2, scope "identify"), nunca con un ID enviado por el cliente.
//
//  GET    /badges               lista pública [{userId,name,image,link}]
//  GET    /auth/start?state=    redirige a Discord para iniciar sesión
//  GET    /auth/callback        Discord vuelve aquí; se crea la sesión
//  GET    /auth/poll?state=     el plugin recoge su token de sesión (una sola vez)
//  PUT    /me/badges            reemplaza MIS insignias (Authorization: Bearer <sesión>)
//  DELETE /auth/session         cierra la sesión
//  POST   /admin/remove         (ADMIN_KEY) quita las insignias de un usuario y opcionalmente lo veta

const MAX_PER_USER = 3;
const MAX_USERS = 500;
const MAX_NAME = 20;
const MAX_IMAGE_CHARS = 100_000; // data: URI (~75 KB); las URL https no cuentan
const MAX_TOTAL_CHARS = 6_000_000;
const SESSION_TTL = 60 * 24 * 3600;
const STATE_RE = /^[A-Za-z0-9_-]{22,64}$/;

const CORS = {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "authorization, content-type",
    "access-control-allow-methods": "GET, PUT, POST, DELETE, OPTIONS"
};

const json = (body, status = 200, extra = {}) =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json; charset=utf-8", ...CORS, ...extra }
    });

const html = text => new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">` +
    `<body style="font-family:system-ui;background:#1e1f22;color:#fff;display:grid;place-items:center;height:100vh;margin:0">` +
    `<div style="text-align:center"><h2>${text}</h2><p>Ya puedes cerrar esta pestaña y volver a Discord.</p></div>`,
    { headers: { "content-type": "text/html; charset=utf-8" } }
);

const enc = new TextEncoder();

async function sha256hex(s) {
    const d = await crypto.subtle.digest("SHA-256", enc.encode(s));
    return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, "0")).join("");
}

async function sameSecret(a, b) {
    const [x, y] = await Promise.all([sha256hex(a), sha256hex(b)]);
    let diff = 0;
    for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
    return diff === 0;
}

function newToken() {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const readList = async env => JSON.parse((await env.BADGES.get("list")) ?? "[]");
const readBanned = async env => JSON.parse((await env.BADGES.get("banned")) ?? "[]");

/** Valida las insignias de UN usuario; devuelve null si algo no cumple. */
function sanitizeMine(list) {
    if (!Array.isArray(list) || list.length > MAX_PER_USER) return null;
    const out = [];
    for (const b of list) {
        if (!b || typeof b !== "object") return null;
        const { name, image, link = "" } = b;
        if (typeof name !== "string" || !name.trim() || name.length > MAX_NAME) return null;
        if (typeof image !== "string") return null;
        const isUrl = /^https:\/\/[^\s]{1,500}$/i.test(image);
        const isData = image.length <= MAX_IMAGE_CHARS && /^data:image\/(png|gif|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(image);
        if (!isUrl && !isData) return null;
        if (typeof link !== "string" || link.length > 300 || (link && !/^https?:\/\//i.test(link))) return null;
        out.push({ name: name.trim(), image, link });
    }
    return out;
}

async function userFromSession(req, env) {
    const m = (req.headers.get("authorization") ?? "").match(/^Bearer\s+(\S{20,100})$/);
    if (!m) return null;
    return await env.BADGES.get(`s:${await sha256hex(m[1])}`);
}

async function handleCallback(url, env) {
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    if (!code || !state || !STATE_RE.test(state)) return html("Solicitud no válida");

    const redirect = `${url.origin}/auth/callback`;
    env = { ...env, DISCORD_CLIENT_ID: (env.DISCORD_CLIENT_ID ?? "").trim(), DISCORD_CLIENT_SECRET: (env.DISCORD_CLIENT_SECRET ?? "").trim() };
    const tok = await fetch("https://discord.com/api/v10/oauth2/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
            client_id: env.DISCORD_CLIENT_ID,
            client_secret: env.DISCORD_CLIENT_SECRET,
            grant_type: "authorization_code",
            code,
            redirect_uri: redirect
        })
    });
    if (!tok.ok) return html("No se pudo iniciar sesión con Discord");
    const { access_token } = await tok.json();

    const me = await fetch("https://discord.com/api/v10/users/@me", { headers: { authorization: `Bearer ${access_token}` } });
    if (!me.ok) return html("No se pudo leer tu usuario de Discord");
    const { id } = await me.json();
    if (!/^\d{15,25}$/.test(id ?? "")) return html("Respuesta de Discord no válida");

    // Ya no necesitamos el token de Discord: lo revocamos.
    await fetch("https://discord.com/api/v10/oauth2/token/revoke", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: env.DISCORD_CLIENT_ID, client_secret: env.DISCORD_CLIENT_SECRET, token: access_token })
    }).catch(() => { });

    const token = newToken();
    await env.BADGES.put(`s:${await sha256hex(token)}`, id, { expirationTtl: SESSION_TTL });
    await env.BADGES.put(`p:${state}`, JSON.stringify({ token, userId: id }), { expirationTtl: 600 });
    return html("Sesión iniciada");
}

function toBase64(bytes) {
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(bin);
}

/**
 * Publica la lista en GitHub (archivo badges.json del repositorio de datos).
 * Los clientes la leen desde raw.githubusercontent.com: gratis y sin límite práctico.
 * Solo escribe si la lista cambió desde la última vez (se ejecuta cada pocos minutos por cron).
 */
async function syncToGitHub(env) {
    const repo = (env.GITHUB_REPO ?? "").trim();
    const token = (env.GITHUB_TOKEN ?? "").trim();
    if (!repo || !token) return;

    const raw = (await env.BADGES.get("list")) ?? "[]";
    const hash = await sha256hex(raw);
    if (hash === (await env.BADGES.get("pushed"))) return;

    const api = `https://api.github.com/repos/${repo}/contents/badges.json`;
    const headers = {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "custom-badge-kazu"
    };

    const cur = await fetch(api, { headers });
    let sha;
    if (cur.ok) sha = (await cur.json()).sha;
    else if (cur.status !== 404) throw new Error(`GitHub GET ${cur.status}`);

    const res = await fetch(api, {
        method: "PUT",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ message: "Update badges", content: toBase64(enc.encode(raw)), ...(sha ? { sha } : {}) })
    });
    if (!res.ok) throw new Error(`GitHub PUT ${res.status}`);
    await env.BADGES.put("pushed", hash);
}

export default {
    async scheduled(_event, env, ctx) {
        ctx.waitUntil(syncToGitHub(env).catch(e => console.error("sync failed", String(e))));
    },

    async fetch(req, env) {
        const url = new URL(req.url);
        const path = url.pathname;
        if (req.method === "OPTIONS") return json("", 204);

        if (path === "/badges" && req.method === "GET")
            return json((await env.BADGES.get("list")) ?? "[]", 200, { "cache-control": "public, max-age=60" });

        if (path === "/auth/start" && req.method === "GET") {
            const state = url.searchParams.get("state") ?? "";
            if (!STATE_RE.test(state) || !env.DISCORD_CLIENT_ID) return json({ error: "bad request" }, 400);
            const to = new URL("https://discord.com/oauth2/authorize");
            to.search = new URLSearchParams({
                client_id: env.DISCORD_CLIENT_ID,
                response_type: "code",
                scope: "identify",
                redirect_uri: `${url.origin}/auth/callback`,
                state
            }).toString();
            return Response.redirect(to.toString(), 302);
        }

        if (path === "/auth/callback" && req.method === "GET") return handleCallback(url, env);

        if (path === "/auth/poll" && req.method === "GET") {
            const state = url.searchParams.get("state") ?? "";
            if (!STATE_RE.test(state)) return json({ error: "bad request" }, 400);
            const v = await env.BADGES.get(`p:${state}`);
            if (!v) return json({ pending: true }, 200, { "cache-control": "no-store" });
            await env.BADGES.delete(`p:${state}`);
            return json(v, 200, { "cache-control": "no-store" });
        }

        if (path === "/auth/session" && req.method === "DELETE") {
            const m = (req.headers.get("authorization") ?? "").match(/^Bearer\s+(\S{20,100})$/);
            if (m) await env.BADGES.delete(`s:${await sha256hex(m[1])}`);
            return json({ ok: true });
        }

        if (path === "/me/badges" && req.method === "PUT") {
            const userId = await userFromSession(req, env);
            if (!userId) return json({ error: "unauthorized" }, 401);
            if ((await readBanned(env)).includes(userId)) return json({ error: "banned" }, 403);

            let body;
            try { body = await req.json(); } catch { return json({ error: "invalid json" }, 400); }
            const mine = sanitizeMine(body);
            if (!mine) return json({ error: "invalid badge list" }, 400);

            const others = (await readList(env)).filter(b => b.userId !== userId);
            const next = [...others, ...mine.map(b => ({ userId, ...b }))];
            if (new Set(next.map(b => b.userId)).size > MAX_USERS) return json({ error: "server full" }, 507);
            if (next.reduce((n, b) => n + b.image.length, 0) > MAX_TOTAL_CHARS) return json({ error: "storage full" }, 507);

            await env.BADGES.put("list", JSON.stringify(next));
            return json({ ok: true, count: mine.length });
        }

        if (path === "/admin/remove" && req.method === "POST") {
            const key = (env.ADMIN_KEY ?? "").trim();
            const given = (req.headers.get("authorization") ?? "").trim();
            if (!key || !(await sameSecret(given, `Bearer ${key}`))) return json({ error: "unauthorized" }, 401);
            let body;
            try { body = await req.json(); } catch { return json({ error: "invalid json" }, 400); }
            if (typeof body?.userId !== "string" || !/^\d{15,25}$/.test(body.userId)) return json({ error: "bad userId" }, 400);

            await env.BADGES.put("list", JSON.stringify((await readList(env)).filter(b => b.userId !== body.userId)));
            if (body.ban) {
                const banned = new Set(await readBanned(env));
                banned.add(body.userId);
                await env.BADGES.put("banned", JSON.stringify([...banned]));
            }
            return json({ ok: true });
        }

        return json({ error: "not found" }, 404);
    }
};
