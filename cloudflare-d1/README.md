# Plausible Analytics dashboard and tracker on Cloudflare D1

This repository is forked from the official [`plausible/analytics`](https://github.com/plausible/analytics) source. It builds Plausible's upstream React dashboard and tracker from `assets/` and `tracker/`. The `cloudflare-d1/` project replaces the upstream Elixir/Phoenix, PostgreSQL, and ClickHouse backend with a Cloudflare Worker and D1 adapter.

This is a custom D1 backend for Plausible's dashboard and event API, not the full upstream Community Edition server. It includes a multi-site list with search and sorting, daily historical reports, common breakdowns, and live collection/reports. Features that require the upstream server or databases—such as funnels, experiments, and some account/team management—are not included. Upstream architecture and requirements are documented in the [official repository](https://github.com/plausible/analytics) and [contribution guide](https://github.com/plausible/analytics/blob/master/CONTRIBUTING.md).

## Historical import and chart resolution

The D1 binding in `wrangler.jsonc` points to the database used for the Viralhooks deployment. The dashboard has a site registry in `pd_sites`; existing Plausible CSV import records are read from `plausible_history`, and new tracker events are stored in `pd_events`, keyed by the registered site's ID. Imported records remain daily aggregates because the Plausible export contains no event timestamps, so hourly history cannot be reconstructed. New events include timestamps and can be reported at finer intervals.

The upstream dashboard displays a note when imported data is included and when a requested interval cannot be derived from the daily export. The source classification and GeoNames lookup files in `data/` are used to render acquisition channels and location names. GeoNames data is licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) and is derived from GeoNames' `cities15000` and `admin1CodesASCII` files.

## Revenue and conversion paths

Configure a revenue event and currency in `/<domain>/settings/general`. The tracker accepts the standard Plausible event shape, for example:

```js
window.plausible('Purchase', {
  revenue: { currency: 'USD', amount: 29.99 }
})
```

The configured event appears as a revenue goal in the dashboard and unlocks revenue and average order value metrics. The Journeys link groups page and event steps within a short-lived session for recent conversions. It does not expose IP addresses, visitor IDs, or cross-session profiles. Imported aggregates do not include transaction-level revenue or event timestamps, so revenue reporting and journeys start with matching live events.

## Deploy your own instance

1. Install dependencies in both source projects:

   ```sh
   cd assets && npm ci
   cd ../cloudflare-d1 && npm ci
   ```

2. Create a D1 database in your Cloudflare account and update `database_name` and `database_id` in `wrangler.jsonc`.
3. Set dashboard credentials as Worker secrets, then apply the migration and deploy:

   ```sh
   npx wrangler secret put ADMIN_PASSWORD
   npx wrangler secret put SESSION_SECRET
   npm run db:migrate
   npm run deploy
   ```

   Use a long random value for `SESSION_SECRET`. The migrations create the live-event tables, source-category lookup, and site registry. The existing Viralhooks deployment is seeded into that registry; additional sites can be added from `/sites`. The migration does not import a Plausible CSV archive.
4. Add the tracker to your website:

   ```html
   <script defer data-domain="viralhooks.org" src="https://YOUR-WORKER.workers.dev/js/script.outbound-links.js"></script>
   ```

   Replace the domain and Worker host for your deployment. Collection begins after this script is installed.

## Licensing and marks

The Plausible source is licensed under [AGPL-3.0-or-later](../LICENSE.md). Plausible Analytics names and marks remain subject to the project's [trademark guidelines](https://plausible.io/docs/trademark-guidelines).
