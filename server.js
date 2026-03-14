/**
 * webx2 — Web Hosting Server with HTTPS
 *
 * HOW IT WORKS:
 *   - On first run, a self-signed TLS certificate is auto-generated via OpenSSL
 *   - HTTP server (port 80 / HTTP_PORT) redirects all traffic to HTTPS
 *   - HTTPS server (port 443 / HTTPS_PORT) serves the admin panel and all registered sites
 *   - Every request's Host header is read — registered domains are served directly
 *   - Run with sudo for automatic /etc/hosts injection (local dev DNS)
 *   - In production, replace the self-signed cert with a real one (e.g. Let's Encrypt)
 */

const express     = require('express');
const http        = require('http');
const https       = require('https');
const path        = require('path');
const crypto      = require('crypto');
const fs          = require('fs');
const { execSync } = require('child_process');

// ── Config ───────────────────────────────────────────────────────
const HTTP_PORT   = parseInt(process.env.HTTP_PORT   || '3000');  // HTTP redirect
const HTTPS_PORT  = parseInt(process.env.HTTPS_PORT  || '3443');  // HTTPS main
const ADMIN_HOST  = process.env.ADMIN_HOST  || 'localhost';
const HOSTS_FILE  = process.env.HOSTS_FILE  || '/etc/hosts';
const HOSTS_TAG   = '# WEBX-MANAGED';
const CERT_DIR    = process.env.CERT_DIR    || path.join(__dirname, 'certs');
const CERT_FILE   = path.join(CERT_DIR, 'cert.pem');
const KEY_FILE    = path.join(CERT_DIR, 'key.pem');

// ── Certificate setup ─────────────────────────────────────────────
// Strategy (in order):
//   1. Use existing certs/cert.pem + certs/key.pem if present
//   2. Try mkcert — generates a browser-trusted local CA cert (no warnings)
//   3. Fall back to OpenSSL self-signed (browser will warn; see instructions below)
//   4. If nothing works, boot in HTTP-only mode on HTTP_PORT

function tryMkcert() {
  try {
    execSync('mkcert -version', { stdio: 'pipe' });
  } catch {
    return false; // mkcert not installed
  }
  try {
    fs.mkdirSync(CERT_DIR, { recursive: true });
    execSync(
      `mkcert -key-file "${KEY_FILE}" -cert-file "${CERT_FILE}" localhost 127.0.0.1 ::1`,
      { stdio: 'pipe' }
    );
    console.log('  [tls] ✓ mkcert certificate generated — browser-trusted, no warnings.');
    return true;
  } catch (e) {
    console.warn('  [tls] mkcert found but failed:', e.message);
    return false;
  }
}

function tryOpenSSL() {
  try {
    execSync('openssl version', { stdio: 'pipe' });
  } catch {
    return false;
  }
  try {
    fs.mkdirSync(CERT_DIR, { recursive: true });
    // Write a proper config file with SAN — required for Chrome/Firefox to accept it
    const cnfPath = path.join(CERT_DIR, 'openssl.cnf');
    fs.writeFileSync(cnfPath, [
      '[req]',
      'default_bits       = 2048',
      'prompt             = no',
      'default_md         = sha256',
      'distinguished_name = dn',
      'x509_extensions    = v3_req',
      '',
      '[dn]',
      'C  = US',
      'ST = Local',
      'L  = Local',
      'O  = webx2',
      'CN = localhost',
      '',
      '[v3_req]',
      'subjectAltName = @alt_names',
      'basicConstraints = CA:FALSE',
      'keyUsage = digitalSignature, keyEncipherment',
      'extendedKeyUsage = serverAuth',
      '',
      '[alt_names]',
      'DNS.1 = localhost',
      'IP.1  = 127.0.0.1',
      'IP.2  = ::1',
    ].join('\n'));

    execSync(
      `openssl req -x509 -newkey rsa:2048 -nodes` +
      ` -keyout "${KEY_FILE}" -out "${CERT_FILE}"` +
      ` -days 825 -config "${cnfPath}"`,
      { stdio: 'pipe' }
    );

    console.log('  [tls] ✓ Self-signed certificate generated via OpenSSL.');
    console.log('');
    console.log('  ┌─────────────────────────────────────────────────────────┐');
    console.log('  │  BROWSER TRUST SETUP (one-time, takes 30 seconds)       │');
    console.log('  │                                                         │');
    console.log('  │  Option A — mkcert (easiest, fully trusted):            │');
    console.log('  │    brew install mkcert   (macOS)                        │');
    console.log('  │    mkcert -install                                      │');
    console.log('  │    Then restart this server.                            │');
    console.log('  │                                                         │');
    console.log('  │  Option B — trust the self-signed cert manually:        │');
    console.log('  │    macOS:   sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain certs/cert.pem');
    console.log('  │    Windows: certutil -addstore -f "ROOT" certs\\cert.pem │');
    console.log('  │    Linux:   sudo cp certs/cert.pem /usr/local/share/ca-certificates/webx2.crt && sudo update-ca-certificates');
    console.log('  │                                                         │');
    console.log('  │  Option C — just click through the browser warning:     │');
    console.log('  │    Chrome: click "Advanced" → "Proceed to localhost"    │');
    console.log('  │    Firefox: click "Advanced" → "Accept the Risk"        │');
    console.log('  └─────────────────────────────────────────────────────────┘');
    console.log('');
    return true;
  } catch (e) {
    console.warn('  [tls] OpenSSL failed:', e.message);
    return false;
  }
}

function ensureCert() {
  if (fs.existsSync(CERT_FILE) && fs.existsSync(KEY_FILE)) {
    console.log('  [tls] Certificate found:', CERT_FILE);
    return true;
  }
  console.log('  [tls] No certificate found. Attempting to generate one...');
  if (tryMkcert()) return true;
  if (tryOpenSSL()) return true;
  return false;
}

// ── Database (swap with Mongo/Redis for production) ───────────────
const db = {
  websites:          new Map(),   // domain string -> site object
  users:             new Map(),   // userId        -> user object
  sessions:          new Map(),   // sessionId     -> userId
  incognitoSessions: new Map(),   // incognitoId   -> session object
};

// ── Constants ────────────────────────────────────────────────────
const RESERVED = new Set([
  'google','facebook','apple','amazon','microsoft','netflix',
  'twitter','instagram','youtube','github','reddit','wikipedia',
  'cloudflare','openai','anthropic','stripe','paypal',
]);

const VALID_TLDS = [
  '.com','.net','.org','.io','.co','.ai',
  '.hell','.void','.dark','.abyss','.inferno',
  '.chaos','.null','.exe','.death','.doom','.fire',
  '.shadow','.blood','.soul','.sin','.curse','.hex',
];

const ERRORS = {
  404:  { code: 404,  name: 'Not Found',        msg: "The page you're looking for doesn't exist.",               color: '#d93025' },
  666:  { code: 666,  name: 'Private',           msg: "This site is private. You don't have permission to view it.", color: '#9c27b0' },
  1944: { code: 1944, name: 'Expired',           msg: 'This site has expired and no longer exists.',              color: '#795548' },
  21:   { code: 21,   name: 'Too Young',         msg: 'Access denied.',                                           color: '#ff6d00' },
  6969: { code: 6969, name: 'Too Wholesome',     msg: 'This page was deemed too nice. Access denied.',            color: '#e91e63' },
  67:   { code: 67,   name: 'Protocol Mismatch', msg: 'Your request was rejected by the server.',                 color: '#5c35cc' },
};

// ── Helpers ──────────────────────────────────────────────────────
function genId()    { return crypto.randomBytes(16).toString('hex'); }
function genToken() { return crypto.randomBytes(32).toString('hex'); }
function hashPw(pw) { return crypto.createHash('sha256').update(pw + 'webx_salt_v1').digest('hex'); }

function normalizeHost(host) {
  return (host || '').split(':')[0].toLowerCase().trim();
}

function parseDomain(raw) {
  const full = (raw || '').toLowerCase().trim()
    .replace(/^https?:\/\//, '').split('/')[0].split(':')[0];
  const parts = full.split('.');
  if (parts.length < 2) return null;
  const tld  = '.' + parts[parts.length - 1];
  const rest = parts.slice(0, -1);
  const apex = rest[rest.length - 1];
  const subs = rest.slice(0, -1);
  return { full, tld, apex, subs, parts };
}

function isDomainTaken(full) {
  const p = parseDomain(full);
  if (!p) return false;
  if (RESERVED.has(p.apex)) return true;
  return db.websites.has(p.full);
}

function isExpired(site) {
  return site.expiresAt ? Date.now() > site.expiresAt : false;
}

function getSessionUser(req) {
  const sid = req.headers['x-session-id'];
  if (!sid) return null;
  const uid = db.sessions.get(sid);
  return uid ? (db.users.get(uid) || null) : null;
}

// ── /etc/hosts management ────────────────────────────────────────
let hostsWritable = true;

function injectHost(domain) {
  if (!hostsWritable) return;
  try {
    const txt = fs.readFileSync(HOSTS_FILE, 'utf8');
    if (txt.split('\n').some(l => l.includes(` ${domain} `))) return;
    fs.appendFileSync(HOSTS_FILE, `127.0.0.1 ${domain} ${HOSTS_TAG}\n`);
    console.log(`  [hosts] + ${domain}`);
  } catch {
    hostsWritable = false;
    console.warn('  [hosts] Not writable (run with sudo for auto DNS). Using fallback URLs.');
  }
}

function removeHost(domain) {
  try {
    const lines = fs.readFileSync(HOSTS_FILE, 'utf8').split('\n');
    fs.writeFileSync(HOSTS_FILE, lines.filter(l => !l.includes(` ${domain} `)).join('\n'));
    console.log(`  [hosts] - ${domain}`);
  } catch { /* silent */ }
}

// ── Error page renderer ──────────────────────────────────────────
function errorPage(code, domain) {
  const e = ERRORS[code] || ERRORS[404];
  return `<!DOCTYPE html><html><head>
<meta charset="UTF-8"><title>${e.code} ${e.name} — webx</title>
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500&family=DM+Mono&display=swap" rel="stylesheet">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'DM Sans',sans-serif;background:#fafafa;color:#202124;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;padding:40px;text-align:center}
.code{font-family:'DM Mono',monospace;font-size:96px;font-weight:500;color:${e.color};line-height:1;margin-bottom:12px}
.name{font-size:24px;font-weight:500;margin-bottom:10px}
.msg{font-size:15px;color:#5f6368;max-width:460px;line-height:1.6;margin-bottom:8px}
.domain{font-family:'DM Mono',monospace;font-size:12px;color:#bbb;margin-bottom:40px}
a{color:${e.color};text-decoration:none;font-weight:500;font-size:14px;padding:10px 24px;border:1px solid ${e.color};border-radius:8px;transition:all .15s}
a:hover{background:${e.color};color:#fff}
</style></head><body>
<div class="code">${e.code}</div>
<div class="name">${e.name}</div>
<div class="msg">${e.msg}</div>
<div class="domain">${domain}</div>
<a href="/">← Back to webx2</a>
</body></html>`;
}

// ── Express app ──────────────────────────────────────────────────
const app = express();
app.use(express.json({ limit: '10mb' }));

// ── Security headers ─────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
});

// ── Domain router — fires first on every HTTPS request ───────────
app.use((req, res, next) => {
  const host = normalizeHost(req.headers.host);
  if (host === ADMIN_HOST || host === 'localhost' || host === '127.0.0.1') return next();

  // Error preview
  const ep = req.path.match(/^\/__error_preview_(\d+)__$/);
  if (ep) return res.send(errorPage(parseInt(ep[1]), host));

  const site = db.websites.get(host);
  if (!site) return res.status(404).send(errorPage(404, host));
  if (isExpired(site)) return res.status(410).send(errorPage(1944, host));

  if (site.isPrivate) {
    const sid  = req.headers['x-session-id'] || req.query._sid;
    const uid  = sid ? db.sessions.get(sid) : null;
    const user = uid ? db.users.get(uid) : null;
    if (!user || user.id !== site.ownerId)
      return res.status(403).send(errorPage(666, host));
  }

  site.views++;
  const badge = `<div style="position:fixed;bottom:12px;right:12px;background:rgba(255,255,255,.95);color:#1a73e8;font-family:'DM Sans',sans-serif;font-size:12px;padding:6px 14px;border:1px solid #e8eaed;border-radius:20px;z-index:2147483647;box-shadow:0 1px 4px rgba(0,0,0,.12);cursor:pointer;" onclick="window.open('/','_blank')">hosted on webx2</div>`;
  const html = site.html.includes('</body>') ? site.html.replace('</body>', badge + '</body>') : site.html + badge;
  res.send(html);
});

app.use(express.static(path.join(__dirname)));

// ── Auth ─────────────────────────────────────────────────────────
app.post('/api/auth/register', (req, res) => {
  const { username, password } = req.body || {};
  if (!username?.trim() || !password) return res.status(400).json({ error: 'Missing fields.' });
  if (username.trim().length < 3) return res.status(400).json({ error: 'Username too short.' });
  for (const u of db.users.values())
    if (u.username.toLowerCase() === username.toLowerCase())
      return res.status(409).json({ error: 'Username already taken.' });
  const id = genId();
  db.users.set(id, { id, username: username.trim(), password: hashPw(password), createdAt: Date.now(), sites: [] });
  const sid = genId();
  db.sessions.set(sid, id);
  res.json({ sessionId: sid, username: username.trim(), userId: id });
});

app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body || {};
  const hash = hashPw(password || '');
  for (const u of db.users.values())
    if (u.username.toLowerCase() === (username || '').toLowerCase() && u.password === hash) {
      const sid = genId();
      db.sessions.set(sid, u.id);
      return res.json({ sessionId: sid, username: u.username, userId: u.id });
    }
  res.status(401).json({ error: 'Wrong username or password.' });
});

app.post('/api/auth/logout', (req, res) => {
  const sid = req.headers['x-session-id'];
  if (sid) db.sessions.delete(sid);
  res.json({ ok: true });
});

// ── Domain API ───────────────────────────────────────────────────
app.get('/api/domain/check', (req, res) => {
  const raw = (req.query.domain || '').trim();
  if (!raw) return res.status(400).json({ error: 'No domain provided.' });
  const p = parseDomain(raw);
  if (!p) return res.status(400).json({ error: 'Invalid domain format.' });
  const reserved = RESERVED.has(p.apex);
  const taken    = isDomainTaken(p.full);
  res.json({
    domain: p.full, available: !taken, reserved, parsed: p,
    suggestion: taken ? `${p.apex}-${Math.floor(Math.random() * 999)}${p.tld}` : null,
  });
});

app.get('/api/domains/tlds', (_req, res) => res.json(VALID_TLDS));

// ── Sites API ────────────────────────────────────────────────────
app.post('/api/sites/create', (req, res) => {
  const user = getSessionUser(req);
  if (!user) return res.status(401).json({ error: 'Not signed in.' });
  const { domain, html, isPrivate, expiresIn, expiresUnit } = req.body || {};
  if (!domain || !html) return res.status(400).json({ error: 'Domain and HTML are required.' });
  const p = parseDomain(domain);
  if (!p) return res.status(400).json({ error: 'Invalid domain.' });
  if (RESERVED.has(p.apex)) return res.status(403).json({ error: `"${p.apex}" is a reserved name.` });
  if (isDomainTaken(p.full)) return res.status(409).json({ error: 'Domain already taken. Choose another.' });
  const mults = { seconds: 1000, minutes: 60000, hours: 3600000, days: 86400000 };
  const expiresAt = (expiresIn && expiresUnit && mults[expiresUnit])
    ? Date.now() + parseInt(expiresIn) * mults[expiresUnit] : null;
  const site = {
    id: genId(), domain: p.full, parsed: p, html,
    ownerId: user.id, ownerName: user.username,
    isPrivate: !!isPrivate, expiresAt,
    createdAt: Date.now(), views: 0,
  };
  db.websites.set(p.full, site);
  user.sites.push(p.full);
  injectHost(p.full);
  res.json({
    ok: true,
    site: { ...site, html: '[hidden]' },
    url: `https://${p.full}:${HTTPS_PORT}/`,
    fallbackUrl: `/__site__/${p.full}`,
    hostsWritable,
  });
});

app.get('/api/sites/my', (req, res) => {
  const user = getSessionUser(req);
  if (!user) return res.status(401).json({ error: 'Not signed in.' });
  const sites = user.sites.map(d => {
    const s = db.websites.get(d);
    if (!s) return null;
    return { id: s.id, domain: s.domain, isPrivate: s.isPrivate, expiresAt: s.expiresAt, createdAt: s.createdAt, views: s.views, expired: isExpired(s) };
  }).filter(Boolean);
  res.json(sites);
});

app.get('/api/sites/all', (_req, res) => {
  const sites = [...db.websites.values()]
    .filter(s => !s.isPrivate && !isExpired(s))
    .map(s => ({ domain: s.domain, ownerName: s.ownerName, createdAt: s.createdAt, views: s.views }))
    .sort((a, b) => b.createdAt - a.createdAt).slice(0, 100);
  res.json(sites);
});

app.get('/api/sites/html/:domain(*)', (req, res) => {
  const user = getSessionUser(req);
  if (!user) return res.status(401).json({ error: 'Not signed in.' });
  const site = db.websites.get(req.params.domain);
  if (!site) return res.status(404).json({ error: 'Not found.' });
  if (site.ownerId !== user.id) return res.status(403).json({ error: 'Not your site.' });
  res.json({ html: site.html });
});

app.put('/api/sites/:domain(*)', (req, res) => {
  const user = getSessionUser(req);
  if (!user) return res.status(401).json({ error: 'Not signed in.' });
  const site = db.websites.get(req.params.domain);
  if (!site) return res.status(404).json({ error: 'Not found.' });
  if (site.ownerId !== user.id) return res.status(403).json({ error: 'Not your site.' });
  if (req.body.html      !== undefined) site.html      = req.body.html;
  if (req.body.isPrivate !== undefined) site.isPrivate = req.body.isPrivate;
  res.json({ ok: true });
});

app.delete('/api/sites/:domain(*)', (req, res) => {
  const user = getSessionUser(req);
  if (!user) return res.status(401).json({ error: 'Not signed in.' });
  const site = db.websites.get(req.params.domain);
  if (!site) return res.status(404).json({ error: 'Not found.' });
  if (site.ownerId !== user.id) return res.status(403).json({ error: 'Not your site.' });
  db.websites.delete(req.params.domain);
  user.sites = user.sites.filter(d => d !== req.params.domain);
  removeHost(req.params.domain);
  res.json({ ok: true });
});

// ── Fallback viewer — /__site__/<domain> ─────────────────────────
app.get('/__site__/:domain(*)', (req, res) => {
  const domain = req.params.domain.toLowerCase();
  const site   = db.websites.get(domain);
  const user   = getSessionUser(req);
  if (!site) return res.status(404).send(errorPage(404, domain));
  if (isExpired(site)) return res.status(410).send(errorPage(1944, domain));
  if (site.isPrivate && (!user || user.id !== site.ownerId))
    return res.status(403).send(errorPage(666, domain));
  site.views++;
  const badge = `<div style="position:fixed;bottom:12px;right:12px;background:rgba(255,255,255,.95);color:#1a73e8;font-family:sans-serif;font-size:12px;padding:6px 14px;border:1px solid #e8eaed;border-radius:20px;z-index:2147483647;box-shadow:0 1px 4px rgba(0,0,0,.12);">hosted on webx</div>`;
  const html = site.html.includes('</body>') ? site.html.replace('</body>', badge + '</body>') : site.html + badge;
  res.send(html);
});

// ── Error previews ───────────────────────────────────────────────
app.get('/__error_preview_:code', (req, res) =>
  res.send(errorPage(parseInt(req.params.code), 'preview')));

// ── Incognito API ────────────────────────────────────────────────
app.post('/api/incognito/start', (_req, res) => {
  const id = genId();
  const session = { id, token: genToken(), createdAt: Date.now(), expiresAt: Date.now() + 3_600_000, fingerprint: genId().slice(0, 16) };
  db.incognitoSessions.set(id, session);
  setTimeout(() => db.incognitoSessions.delete(id), 3_600_000);
  res.json({ id, token: session.token, expiresAt: session.expiresAt, fingerprint: session.fingerprint });
});

app.delete('/api/incognito/:id', (req, res) => {
  const s = db.incognitoSessions.get(req.params.id);
  if (!s || s.token !== req.body?.token) return res.status(403).json({ error: 'Invalid token.' });
  db.incognitoSessions.delete(req.params.id);
  res.json({ ok: true });
});

// ── Admin panel catch-all ────────────────────────────────────────
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// ── HTTP → HTTPS redirect server ─────────────────────────────────
const redirectApp = express();
redirectApp.use((req, res) => {
  const host = normalizeHost(req.headers.host);
  res.redirect(301, `https://${host}:${HTTPS_PORT}${req.url}`);
});

// ── Boot ─────────────────────────────────────────────────────────
const certReady = ensureCert();

if (certReady) {
  const tlsOptions = {
    key:  fs.readFileSync(KEY_FILE),
    cert: fs.readFileSync(CERT_FILE),
  };

  // HTTP → HTTPS redirect
  http.createServer(redirectApp).listen(HTTP_PORT, () => {
    console.log(`  [http]  http://localhost:${HTTP_PORT}  → redirects to HTTPS`);
  });

  // Main HTTPS server
  https.createServer(tlsOptions, app).listen(HTTPS_PORT, () => {
    console.log(`
  webx2 running — HTTPS mode
  Admin    → https://localhost:${HTTPS_PORT}
  Fallback → https://localhost:${HTTPS_PORT}/__site__/<domain>
  Redirect → http://localhost:${HTTP_PORT}  (→ HTTPS)
  Certs    → ${CERT_DIR}
`);
  });
} else {
  // No cert available — run HTTP only
  console.warn('  [tls] Could not generate a certificate. Starting in HTTP-only mode.');
  http.createServer(app).listen(HTTP_PORT, () => {
    console.log(`
  webx2 running — HTTP mode (no HTTPS)
  Admin    → http://localhost:${HTTP_PORT}
  Fallback → http://localhost:${HTTP_PORT}/__site__/<domain>

  To enable HTTPS, install mkcert:
    macOS:   brew install mkcert && mkcert -install
    Windows: choco install mkcert  (or scoop install mkcert)
    Linux:   https://github.com/FiloSottile/mkcert#installation
  Then restart this server.
`);
  });
}
