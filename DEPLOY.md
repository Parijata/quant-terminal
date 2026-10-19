# Publish Quant Terminal on Render

This project can run as a private, password-protected web service on Render's free
plan. Free hosting is suitable for trying the app, with the storage and sleep limits
described below.

## Publish

1. Put this folder in a Git repository that you own and push it to GitHub.
2. In Render, choose **New > Blueprint**, connect that repository, and deploy its
   `render.yaml` file.
3. When Render asks for `QT_AUTH_USER` and `QT_AUTH_PASSWORD`, set a username and
   a long, unique password. Keep the password private.
4. Wait for the deploy to report **Live**, then open the `onrender.com` address
   shown in the Render dashboard. Your browser will ask you to sign in.

The Blueprint uses Render's free web service. Render spins a free service down
after 15 minutes without traffic, and it can take about a minute to wake again.
Its filesystem is temporary, so watchlists, settings, imports, alerts, and other
server-saved data can disappear when the service sleeps, restarts, or redeploys.
The `/healthz` route is public for the host's health check; all app pages and APIs
require sign-in. See Render's current [free service limits](https://render.com/docs/free).

If you later want server-saved data to survive restarts, the app will need a
persistent paid disk or a database-backed storage update.

The app does not connect to a broker. It displays market data and paper-trading
features only.
