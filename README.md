# SICI website — final static package

## Files
- `index.html` — responsive homepage with opening SICI ident
- `about.html`
- `contact.html`
- `careers/index.html` — Expert Network application page
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
The page UI and client-side validation are integrated. A Cloudflare Worker + private R2/D1 backend is in `careers-worker/`; deployment requires access to the SICI Cloudflare account and Resend domain credentials. See `careers-worker/README.md` for setup and where application notifications and records appear. The form remains in preview mode until the Worker URL and Turnstile site key are configured.
