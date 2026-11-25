// Accès aux fichiers OneDrive via Microsoft Graph.

const G = 'https://graph.microsoft.com/v1.0';
let tokenFn = null;

export function init(fn) { tokenFn = fn; }

export class GraphError extends Error {
  constructor(status, msg) { super(msg); this.status = status; }
}

export const encPath = p => String(p).split('/').filter(Boolean).map(encodeURIComponent).join('/');
export const joinPath = (...parts) => parts.flatMap(p => String(p || '').split('/')).filter(Boolean).join('/');
const rootPath = p => `/me/drive/root:/${encPath(p)}:`;

async function req(url, opts = {}, retry = true) {
  const token = await tokenFn(false);
  const r = await fetch(url.startsWith('http') ? url : G + url, {
    ...opts,
    headers: { ...(opts.headers || {}), Authorization: 'Bearer ' + token },
  });
  if (r.status === 401 && retry) { await tokenFn(true); return req(url, opts, false); }
  if (!r.ok) {
    let msg = r.statusText || `HTTP ${r.status}`;
    try { const j = await r.json(); msg = j.error?.message || msg; } catch { /* ignore */ }
    throw new GraphError(r.status, msg);
  }
  return r;
}

export async function listChildren(path) {
  let url = `${rootPath(path)}/children?$top=500`;
  const out = [];
  while (url) {
    const j = await (await req(url)).json();
    out.push(...j.value);
    url = j['@odata.nextLink'];
  }
  return out;
}

export async function readItem(item) {
  const dl = item['@microsoft.graph.downloadUrl'];
  if (dl) {
    try { const r = await fetch(dl); if (r.ok) return await r.text(); } catch { /* repli ci-dessous */ }
  }
  return (await req(`/me/drive/items/${item.id}/content`)).text();
}

export async function readPath(path) {
  return (await req(`${rootPath(path)}/content`)).text();
}

export async function createFile(folder, name, text) {
  const r = await req(`${rootPath(joinPath(folder, name))}/content?@microsoft.graph.conflictBehavior=rename`, {
    method: 'PUT', headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body: text,
  });
  return r.json();
}

export async function writeFile(id, text, eTag) {
  const headers = { 'Content-Type': 'text/plain; charset=utf-8' };
  if (eTag) headers['If-Match'] = eTag;
  return (await req(`/me/drive/items/${id}/content`, { method: 'PUT', headers, body: text })).json();
}

export async function moveRename(id, { name, folder }) {
  const body = {};
  if (name) body.name = name;
  if (folder) {
    const p = await (await req(`${rootPath(folder)}?$select=id`)).json();
    body.parentReference = { id: p.id };
  }
  return (await req(`/me/drive/items/${id}?@microsoft.graph.conflictBehavior=rename`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })).json();
}

export async function deleteItem(id) {
  await req(`/me/drive/items/${id}`, { method: 'DELETE' });
}

/** Cherche les coffres Obsidian (dossiers contenant un .obsidian). */
export async function findVaults() {
  const j = await (await req(`/me/drive/root/search(q='.obsidian')?$top=200`)).json();
  const out = new Set();
  for (const it of j.value) {
    if (!it.folder || it.name !== '.obsidian') continue;
    let path = it.parentReference?.path;
    if (!path) {
      try { path = (await (await req(`/me/drive/items/${it.id}?$select=parentReference`)).json()).parentReference?.path; }
      catch { continue; }
    }
    if (!path) continue;
    const p = decodeURIComponent(path.replace(/^\/drive\/root:\/?/, ''));
    if (!/(^|\/)\.|sauvegarde|backup/i.test(p)) out.add(p);
  }
  return [...out];
}
