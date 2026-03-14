# webx2

Second addition to [webx](https://github.com/webxplatform/webx), now with HTTPS.

Everything webx can do is here — register any domain at any subdomain depth, publish raw HTML, set sites as public or private, give them a lifespan in seconds through days, browse in incognito mode, and six custom error codes. webx2 adds a full TLS layer on top of all of that.

---

## Quick start

```bash
npm install
node server.js
```

Open at **https://localhost:3443**

---

## HTTPS

The server automatically finds or generates a certificate on startup. No manual steps required.

**How it works:**

On boot the server checks for `certs/cert.pem` and `certs/key.pem`. If they exist it loads them and starts. If they do not exist it tries to generate them in this order:

1. **mkcert** — if installed, generates a certificate signed by a local CA that mkcert installs into your system keychain. The browser trusts it completely. No warning. Full green padlock. This is the recommended path.

2. **OpenSSL** — if mkcert is not available but OpenSSL is, generates a self-signed certificate with the correct Subject Alternative Names for localhost. The browser will show a security warning because no trusted CA signed it. You can click through the warning or manually trust the cert in your OS keychain (instructions printed in the terminal on first run).

3. **HTTP-only fallback** — if neither mkcert nor OpenSSL is available the server starts in plain HTTP mode on port 3000. Everything works, just no HTTPS.

**To get HTTPS with no browser warning, install mkcert once:**

```bash
# macOS
brew install mkcert
mkcert -install

# Windows
choco install mkcert
mkcert -install

# Linux (Debian/Ubuntu)
apt install libnss3-tools
curl -Lo mkcert https://github.com/FiloSottile/mkcert/releases/latest/download/mkcert-v1.4.4-linux-amd64
chmod +x mkcert && sudo mv mkcert /usr/local/bin
mkcert -install
```

Then restart the server. It detects mkcert automatically and generates a trusted cert.

**Ports:**

- `3443` — HTTPS, serves everything
- `3000` — HTTP, redirects all traffic to HTTPS on 3443

Both ports are configurable via environment variables.

**Bring your own certificate:**

Place `cert.pem` and `key.pem` in the `certs/` folder before starting the server and it will use them as-is, skipping generation entirely. This is how you plug in a Let's Encrypt certificate for production.

---

## Domains

webx2 accepts any domain you type. There are no restrictions on TLD, subdomain depth, or naming — anything goes as long as it has at least two parts.

Examples of valid domains:

```
hello.com
mysite.io
whatever.dark.sea.eater.com
a.b.c.d.e.f.net
blog.ai
```

The only names blocked are a short list of major brands to prevent impersonation: google, facebook, apple, amazon, microsoft, netflix, twitter, instagram, youtube, github, reddit, wikipedia, cloudflare, openai, anthropic, stripe, paypal.

Beyond that, first come first served. Once a domain is registered nobody else can take it.

**Available TLDs shown as quick-pick chips on the home page:**

Standard — `.com` `.net` `.org` `.io` `.co` `.ai`

Custom — `.hell` `.void` `.dark` `.abyss` `.inferno` `.chaos` `.null` `.exe` `.death` `.doom` `.fire` `.shadow` `.blood` `.soul` `.sin` `.curse` `.hex`

Any TLD you type manually works too. These are just shortcuts.

---

## Creating a site

Open the Create page, enter a domain name, choose visibility and lifespan, write HTML in the editor, and hit Publish. The site goes live immediately.

The editor has buttons for inserting a full HTML template, a style block, and a script block. There is a live preview panel that renders your HTML in an iframe before you publish. A character counter shows the current size of your code.

After publishing, a working URL is shown and you can open the site immediately.

---

## Visibility

Every site is either public or private. You choose when creating it and can change it later from the dashboard.

**Public** — anyone with the URL can visit it. It appears in the public Explore directory.

**Private** — only the owner can view it. Anyone else who visits gets error 666. It does not appear in the Explore directory.

---

## Site lifespan

Sites can be permanent or set to expire automatically. When creating a site you choose an amount and a unit:

- Seconds
- Minutes
- Hours
- Days

Leave both blank for a permanent site. The dashboard shows a live countdown timer for any site with an expiry. When a site expires it stops serving content and returns error 1944 to all visitors.

---

## Incognito mode

Starts a temporary browsing session with a randomized fingerprint. Nothing is logged server-side while incognito is active. The session is automatically destroyed after one hour, or immediately when you click End session. When the session ends all traces are wiped.

---

## Error codes

webx2 has six custom error pages. Each has its own styled page with the error code displayed large.

**404 — Not Found**
The domain is not registered on webx2. Returned when someone visits a URL that does not exist.

**666 — Private**
The site exists but is set to private. Returned to anyone who visits a private site and is not the owner.

**1944 — Expired**
The site existed but its lifespan has ended. Returned to all visitors including the owner once a timed site expires.

**21 — Too Young**
Access denied.

**6969 — Too Wholesome**
This page was deemed too nice. Access denied.

**67 — Protocol Mismatch**
Your request was rejected by the server.

All six error pages can be previewed from the Error codes tab in the dashboard without needing to trigger them.

---

## Dashboard

Shows all sites registered to your account. Each entry displays the domain, visibility badge, view count, creation date, and a live countdown if the site has an expiry. From the dashboard you can visit, edit, or delete any site.

---

## Explore

A public directory of all non-private, non-expired sites on webx2. Shows domain, owner, view count, and creation date with a Visit button for each.

---

## Local domain routing

When you register `mysite.com`, the server appends `127.0.0.1 mysite.com` to `/etc/hosts` so the domain resolves to your machine. Visiting `https://mysite.com:3443/` then serves that site directly from the root — no `/site/` path prefix, no redirect.

This requires running the server with sudo. Without sudo the hosts file cannot be written and a fallback URL at `https://localhost:3443/__site__/<domain>` is provided instead, which always works without DNS.

In production, point a wildcard DNS record `*.yourdomain.com` to your server IP and every registered domain resolves globally with no hosts file needed.

---

## API

All routes are under `/api/`. Authenticated routes require an `x-session-id` header with the token returned at login.

| Method | Route | Description |
|--------|-------|-------------|
| POST | `/api/auth/register` | Create account |
| POST | `/api/auth/login` | Sign in |
| POST | `/api/auth/logout` | Sign out |
| GET | `/api/domain/check?domain=` | Check availability |
| GET | `/api/domains/tlds` | List suggested TLDs |
| POST | `/api/sites/create` | Publish a site |
| GET | `/api/sites/my` | List your sites |
| GET | `/api/sites/all` | List all public sites |
| GET | `/api/sites/html/:domain` | Get your site's HTML source |
| PUT | `/api/sites/:domain` | Update HTML or visibility |
| DELETE | `/api/sites/:domain` | Delete a site |
| POST | `/api/incognito/start` | Start incognito session |
| DELETE | `/api/incognito/:id` | Destroy incognito session |

Special routes (no auth needed):

| Route | Description |
|-------|-------------|
| `/__site__/<domain>` | View any registered site — always works without DNS |
| `/__error_preview_<code>` | Preview any error page |

---

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `HTTPS_PORT` | `3443` | HTTPS server port |
| `HTTP_PORT` | `3000` | HTTP redirect port |
| `ADMIN_HOST` | `localhost` | Admin panel hostname |
| `CERT_DIR` | `./certs` | Certificate storage folder |
| `HOSTS_FILE` | `/etc/hosts` | Hosts file for DNS injection |

---

## Project structure

```
webx2/
├── server.js     Node.js + Express backend with HTTPS
├── index.html    Full frontend, single file, no build step
├── package.json
└── certs/        Created automatically on first run
    ├── cert.pem
    └── key.pem
```

Data is stored in memory. A server restart clears all sites and accounts. For persistence, swap the in-memory Maps in server.js for a real database.

---

## Production

- Replace `certs/` with a real certificate from Let's Encrypt or another CA
- Add a wildcard DNS record pointing to your server so all domains resolve
- Run behind nginx or Caddy for load balancing and port 443 without root
- Use PM2 or systemd to keep the process running
- Swap the in-memory database for MongoDB, Redis, or SQLite
