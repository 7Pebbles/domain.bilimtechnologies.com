# Bilim Domain Watch

Domain renewal and website-health dashboard for `domains.bilimtechnologies.in`.

## Local setup

```bash
cp .env.example .env
npm install
npm start
```

Open `http://localhost:3000`. Domain checks run on startup, every `CHECK_INTERVAL_HOURS`, and on demand. Reminders are evaluated hourly and sent once per configured threshold and expiry cycle.

Use **Add domain** in the dashboard to record new purchases. The domain name, purchase date, renewal date, and annual price are saved to Turso and immediately included in monitoring.

## PWA and push notifications

The dashboard is installable from a supported browser and has an offline application shell. Use **Enable notifications** under Renewal Reminders to subscribe the current browser to renewal and domain-down alerts.

Generate production VAPID credentials with `npx web-push generate-vapid-keys`, then set `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, and `VAPID_SUBJECT` in `.env`. Push notifications require HTTPS in production; `localhost` is allowed for local testing. Subscriptions and delivered renewal thresholds are persisted in Turso.

## Email reminders

Set `REMINDER_EMAIL`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, and `SMTP_FROM` in `.env`. Use the **Test email** button to validate delivery. Default reminder thresholds are 60, 30, 14, 7, 3, and 1 days before renewal.

Set `ADMIN_USER` and `ADMIN_PASSWORD` before exposing the service publicly. Without both values, the dashboard is not password protected.

## Production deployment

### Vercel

The app is configured for Vercel serverless hosting. Turso stores all persistent data, while authenticated Vercel Cron jobs check domain health at 01:00 UTC and send reminders at 02:00 UTC each day.

1. Import the GitHub repository into Vercel with Framework Preset set to **Other**.
2. Add every variable from `.env.example` to the Vercel project settings. At minimum, configure `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, `CRON_SECRET`, `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, and `VAPID_SUBJECT`.
3. Add SMTP variables to activate email reminders and `ADMIN_USER`/`ADMIN_PASSWORD` to protect the dashboard.
4. Deploy and attach the custom domain in Vercel. HTTPS is provisioned automatically and enables PWA installation and web push.

Do not expose `TURSO_AUTH_TOKEN`, `VAPID_PRIVATE_KEY`, or `CRON_SECRET` in client-side variables. The supplied `vercel.json` schedules both cron jobs.

### Docker

1. Point an `A` or `AAAA` DNS record for `domains.bilimtechnologies.in` to the server.
2. Create `.env` from `.env.example` and fill in Turso, SMTP, and admin credentials.
3. Run `docker compose up -d --build`.
4. Install `deploy/nginx.conf` as an Nginx site and reload Nginx.
5. Issue TLS with `sudo certbot --nginx -d domains.bilimtechnologies.in`.

Turso preserves domains, latest health results, reminder delivery state, and push subscriptions across deployments.
# domain.bilimtechnologies.com
