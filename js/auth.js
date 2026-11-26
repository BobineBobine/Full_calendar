// Connexion Microsoft (compte personnel) en OAuth 2 "code + PKCE", sans serveur ni librairie.

const AUTH = 'https://login.microsoftonline.com/consumers/oauth2/v2.0';
const SCOPES = 'Files.ReadWrite offline_access';
const K = 'fc.tokens';

export class NeedLogin extends Error {}

// Une seule adresse de retour pour toutes les applis du dépôt (Calendrier, Notes du jour) :
// la racine du site. Une appli placée dans un sous-dossier y revient ensuite (returnTo).
export function redirectUri() {
  return new URL('../', import.meta.url).href;
}

function b64url(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
const rand = n => b64url(crypto.getRandomValues(new Uint8Array(n)));

function loadTok() { try { return JSON.parse(localStorage.getItem(K)) || null; } catch { return null; } }
function saveTok(t) {
  try { t ? localStorage.setItem(K, JSON.stringify(t)) : localStorage.removeItem(K); } catch { /* ignore */ }
}

export function isLoggedIn() { const t = loadTok(); return !!(t && (t.refresh_token || t.access_token)); }
export function logout() { saveTok(null); }

export async function login(clientId, { silent = false, returnTo = null } = {}) {
  const verifier = rand(48), state = rand(16);
  const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  sessionStorage.setItem('fc.pkce', JSON.stringify({ verifier, state, silent, returnTo }));
  const p = new URLSearchParams({
    client_id: clientId, response_type: 'code', redirect_uri: redirectUri(), scope: SCOPES,
    code_challenge: challenge, code_challenge_method: 'S256', state, response_mode: 'query',
  });
  if (silent) p.set('prompt', 'none');
  location.assign(`${AUTH}/authorize?${p}`);
}

/** À appeler au démarrage : termine la connexion si on revient de la page Microsoft. */
export async function handleRedirect(clientId) {
  const q = new URLSearchParams(location.search);
  if (!q.has('code') && !q.has('error')) return null;
  let saved = null;
  try { saved = JSON.parse(sessionStorage.getItem('fc.pkce') || 'null'); } catch { /* ignore */ }
  sessionStorage.removeItem('fc.pkce');
  history.replaceState(null, '', redirectUri());
  const back = saved?.returnTo;
  // Connexion lancée depuis une autre appli du dépôt : on termine ici puis on y retourne.
  const goBack = err => {
    location.replace(back + (err ? '#auth-error=' + encodeURIComponent(err) : ''));
    return new Promise(() => {});
  };
  if (q.has('error')) {
    if (back) return goBack(q.get('error_description') || q.get('error'));
    return { error: q.get('error'), description: q.get('error_description'), silent: !!saved?.silent };
  }
  if (!saved || saved.state !== q.get('state')) return { error: 'state_mismatch' };
  try {
    await tokenRequest(clientId, {
      grant_type: 'authorization_code', code: q.get('code'),
      redirect_uri: redirectUri(), code_verifier: saved.verifier,
    });
  } catch (e) { if (back) return goBack(e.message); throw e; }
  if (back) return goBack();
  return { ok: true };
}

async function tokenRequest(clientId, params) {
  const r = await fetch(`${AUTH}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, scope: SCOPES, ...params }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error(j.error_description || j.error || `Erreur jeton ${r.status}`);
    e.code = j.error;
    throw e;
  }
  saveTok({
    access_token: j.access_token,
    refresh_token: j.refresh_token || loadTok()?.refresh_token,
    exp: Date.now() + (j.expires_in - 120) * 1000,
  });
}

let refreshing = null;

export async function getToken(clientId, force = false) {
  const t = loadTok();
  if (!t) throw new NeedLogin('Non connecté');
  if (!force && t.access_token && Date.now() < t.exp) return t.access_token;
  if (!t.refresh_token) throw new NeedLogin('Session expirée');
  if (!refreshing) {
    refreshing = tokenRequest(clientId, { grant_type: 'refresh_token', refresh_token: t.refresh_token })
      .catch(e => {
        if (e.code === 'invalid_grant' || e.code === 'interaction_required') {
          saveTok(null);
          throw new NeedLogin(e.message);
        }
        throw e;
      })
      .finally(() => { refreshing = null; });
  }
  await refreshing;
  return loadTok().access_token;
}
