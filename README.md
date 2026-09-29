# SICI website — final static package

## Files
- `index.html` — responsive homepage with opening SICI ident
- `about.html`
- `contact.html`
- `assets/` — separate image assets, favicon and Open Graph image
- `robots.txt`
- `sitemap.xml`

## Navigation
- SICI logo → Home
- Work → Selected Work on Home
- About → About page
- SICI.dev ↗ → external
- Contact → Contact page

## Contact form
The current static implementation opens the visitor's email application with the completed form content addressed to `hello@sici.uk`.
If the deployed host provides a serverless/form endpoint, this can later be changed without altering the page design.

## Selected Work
Real image assets are linked as separate files rather than embedded in the HTML.
Donor Mapping intentionally uses the typographic/data treatment until a real visual is available.

## Homepage intro
Runs once per browser session. It is not repeated on About or Contact.
