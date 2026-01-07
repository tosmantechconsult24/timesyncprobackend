Deployment quick guide (script-based)

1) Copy `.env.example` -> `.env` and fill in production values (especially `DATABASE_URL`).

2) Transfer repo to server (git clone or rsync), cd into `backend`.

3) Run the deployment script (it will run migrations, build and start pm2):

```bash
chmod +x deploy_production.sh
./deploy_production.sh
```

4) Configure Nginx using `nginx_timesync.conf.template` (replace placeholders). Reload Nginx.

5) Verify endpoints:

```bash
curl -i https://your.domain.example/health
curl -i https://your.domain.example/ready

# simulate kiosk
curl -X POST https://your.domain.example/api/attendance/record \
  -H "Content-Type: application/json" \
  -d '{"employeeId":"<id>","type":"CLOCK_IN"}'
```

6) Review pm2 logs:

```bash
pm2 logs timesync-backend --lines 200
```
