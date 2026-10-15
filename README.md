# SICI website and Careers application service

## Files
- `index.html` — responsive homepage with opening SICI ident
- `about.html`
- `contact.html`
- `careers/index.html` — Expert Network application page and multipart application form
- `server.mjs` — same-origin website server, application API and authenticated review screen
- `Dockerfile` — Dokploy production image
- `assets/` — separate image assets, favicon and Open Graph image
- `robots.txt`
- `sitemap.xml`

## Navigation
- SICI logo → Home
- Work → Selected Work on Home
- About → About page
- SICI.dev ↗ → external
- Contact → Contact page
- Careers → `/careers`

## Contact form
The current static implementation opens the visitor's email application with the completed form content addressed to `hello@sici.uk`.
If the deployed host provides a serverless/form endpoint, this can later be changed without altering the page design.

## Selected Work
Real image assets are linked as separate files rather than embedded in the HTML.
Donor Mapping intentionally uses the typographic/data treatment until a real visual is available.

## Homepage intro
Runs once per browser session. It is not repeated on About or Contact.

## Careers application
The form posts to the same-origin `/api/careers` endpoint served by `server.mjs`. Applications and CV files are encrypted with AES-256-GCM and stored outside the public site root in the persistent Dokploy volume mounted at `/data`. PDF and DOCX file signatures, required fields, consent, origin, request size, and a per-IP daily limit are checked by the server. Records are deleted after 180 days.

Review applications at `https://sici.uk/careers/admin` using the HTTP Basic Authentication credentials configured in Dokploy. CV files can only be downloaded from that authenticated screen. An optional Resend notification can be enabled by setting `RESEND_API_KEY`; notifications go to `hello@sici.uk` by default and never include the CV attachment. Without that key, applications are still saved securely and appear in the review screen.

Required Dokploy environment variables: `CAREERS_ENCRYPTION_KEY` (base64-encoded 32 random bytes), `CAREERS_RATE_LIMIT_SECRET` (random secret of at least 32 characters), `CAREERS_ADMIN_USER`, and `CAREERS_ADMIN_PASSWORD` (at least 20 characters). `DATA_DIR` defaults to `/data`; the Dokploy persistent volume must be mounted there. Optional variables: `RETENTION_DAYS`, `RESEND_API_KEY`, `NOTIFICATION_TO`, and `NOTIFICATION_FROM`.
