/*
 * Custom Badge by Kazu - parte nativa.
 * Corre en el proceso principal de Discord para hablar con el servidor de insignias
 * (el renderer de Discord bloquea casi todas las conexiones externas).
 */

import { IpcMainInvokeEvent } from "electron";

const MAX_LIST_CHARS = 10_000_000;

/** Lee la lista pública de insignias desde GitHub (solo raw.githubusercontent.com, solo https). */
export async function fetchList(_: IpcMainInvokeEvent, url: string) {
    try {
        if (new URL(url).origin !== "https://raw.githubusercontent.com") throw new Error("Origen no permitido");
        const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
        const data = await res.text();
        if (data.length > MAX_LIST_CHARS) throw new Error("Lista demasiado grande");
        return { status: res.status, data };
    } catch (e) {
        return { status: -1, data: String(e) };
    }
}

const ALLOWED = [
    /^GET \/badges$/,
    /^GET \/auth\/poll\?state=[A-Za-z0-9_-]{22,64}$/,
    /^PUT \/me\/badges$/,
    /^DELETE \/auth\/session$/
];

/** Única puerta de salida: solo https y solo las rutas del servidor de insignias. */
export async function api(
    _: IpcMainInvokeEvent,
    base: string,
    method: string,
    path: string,
    token?: string,
    body?: string
) {
    try {
        const origin = new URL(base).origin;
        if (!origin.startsWith("https://")) throw new Error("Solo se permite https");
        if (!ALLOWED.some(re => re.test(`${method} ${path}`))) throw new Error("Ruta no permitida");

        const res = await fetch(origin + path, {
            method,
            headers: {
                ...(body ? { "Content-Type": "application/json" } : {}),
                ...(token ? { Authorization: `Bearer ${token}` } : {})
            },
            body,
            signal: AbortSignal.timeout(20_000)
        });
        return { status: res.status, data: await res.text() };
    } catch (e) {
        return { status: -1, data: String(e) };
    }
}
