Production Setup Checklist

1) Environment
- Create a `.env` from `.env.example` and set `DATABASE_URL` to your production database.
- Ensure `PORT` is not already taken by another system service.

2) Reverse Proxy (recommended)
- Put Nginx (or IIS/Apache) in front of the Node process. Proxy traffic to the app's PORT (e.g., 5000).
- This lets you bind to standard HTTP ports on the proxy and keep the Node app on an internal port.

3) Process manager
- Install `pm2` globally: `npm i -g pm2`.
- Start app with `pm2 start ecosystem.config.js` (this will run `dist/index.js`).
- Use `pm2 logs timesync-backend` to follow logs, `pm2 stop timesync-backend` to stop.

4) Health & readiness
- The server exposes `/health` and `/ready` endpoints. Configure your load balancer or orchestrator to use `/ready` for readiness checks and `/health` for liveness.

5) SSL / TLS
- Terminate HTTPS at the reverse proxy and forward HTTP to the Node app.

6) Logging
- Logs are written via the existing logger. Use log rotation/collection (e.g., via pm2-logrotate or centralized logging).

7) Database
- Use a managed DB for production. Run Prisma migrations against the production DB prior to startup.

8) Security
- Set `CORS_ORIGINS` to your front-end host(s).
- Ensure environment secrets are kept secure.

9) Start
- Build: `npm run build`
- Start: `pm2 start ecosystem.config.js` or `NODE_ENV=production PORT=5000 node dist/index.js`

If you'd like, I can prepare a small deployment script and an example Nginx config next.
