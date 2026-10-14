# SICI Careers submission service

The public site is static GitHub Pages. This Cloudflare Worker receives application forms, validates the CV, stores the CV in a private R2 bucket and applicant details in D1, then sends a notification to `hello@sici.uk` through Resend. The email deliberately excludes the CV attachment. Applications and CVs are retained for 180 days, then automatically removed by the daily Worker cron.

## One-time setup

These commands require access to the SICI Cloudflare account and a verified sending domain in Resend.

1. Install Wrangler from Cloudflare's official package and authenticate to the SICI Cloudflare account: `npm install --save-dev wrangler` then `npx wrangler login`.
2. From this folder, create the private storage resources:

   ```powershell
   npx wrangler r2 bucket create sici-careers-cv
   npx wrangler d1 create sici-careers
   ```

3. Put the returned D1 database ID in `wrangler.toml`, replacing `REPLACE_WITH_D1_DATABASE_ID`.
4. Create a Cloudflare Turnstile widget for `sici.uk` and set its secret. Set a random rate limit secret too:

   ```powershell
   npx wrangler secret put TURNSTILE_SECRET_KEY
   npx wrangler secret put RATE_LIMIT_SECRET
   ```

5. Create a Resend API key for the verified `sici.uk` sender domain and set it:

   ```powershell
   npx wrangler secret put RESEND_API_KEY
   ```

6. Apply the schema and deploy:

   ```powershell
   npx wrangler d1 migrations apply sici-careers --remote
   npx wrangler deploy
   ```

7. In `careers/index.html`, set `SUBMISSION_ENDPOINT` to the deployed Worker URL and `TURNSTILE_SITE_KEY` to the public site key. Publish the static site update.

## Where applications appear

- New application notification email goes to `hello@sici.uk`. It contains the applicant's name, email, country, selected expertise and Cloudflare storage location. CV files are not attached.
- In Cloudflare Dashboard, open **R2 Object Storage → `sici-careers-cv` → `applications/`** to view/download CVs.
- Open **Workers & Pages → D1 SQL Database → `sici-careers` → `applications`** to review complete application details and notification status.
- Keep the R2 bucket private; do not enable public access. Limit Cloudflare account access to the people who review applications.

If the notification email fails, the application remains stored and the applicant receives a success confirmation. The D1 `notification_sent` field records that case so it can be followed up.
