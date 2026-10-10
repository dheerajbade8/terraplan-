# Terraplan (frontend + backend + database)

Construction progress, wages and resources for project managers and site supervisors.

| Layer | Technology | Where |
|---|---|---|
| Frontend | HTML, CSS, JavaScript (no framework) | `public/` |
| Backend | Node.js + Express REST API, JWT login, bcrypt passwords | `server.js` |
| Database | SQLite (tables: users, projects, areas, workers, wages, resources, requests, reports, expenses, issues, audit) | `db.js` |

All rules are enforced on the server (who can approve, who owns which area, wage calculation, stock checks), not just in the browser.

## Run locally

Requires **Node.js 22 or newer**.

```bash
npm install
npm start            # http://localhost:3000
npm test             # 34 end-to-end checks on a temporary database
```

Demo logins (password `demo123`): `manager@terraplan.demo`, `ravi@terraplan.demo`, `anita@terraplan.demo`, `dev@terraplan.demo`.

Copy `.env.example` to `.env` values into your environment before real use. At minimum set `JWT_SECRET`.

## Real users (no demo accounts)

```bash
SEED_DEMO=false npm start         # first run creates an empty database
npm run create-user -- "Meera Rao" meera@example.com manager "a-strong-password"
```

## API overview

All routes except `/api/login` need `Authorization: Bearer <token>`.

- `POST /api/login`, `GET /api/state`
- Manager: `POST /api/projects`, `PUT /api/areas/:id/schedule`, `POST /api/wages/:id/approve`, `POST /api/wages/approve-all`, `POST /api/resources/:id/stock`, `POST /api/requests/:id/decide`, `POST /api/expenses`, `POST /api/issues/:id/resolve`
- Supervisor: `POST /api/reports`, `POST /api/workers`, `PUT /api/attendance`, `POST /api/wages/submit`, `POST /api/resources/:id/use`, `POST /api/requests`, `POST /api/issues`

## Deploy on Google Cloud

### Important: the database file must live on storage that survives restarts

SQLite stores data in a file. **Cloud Run's disk is temporary**, so a plain Cloud Run deploy loses data whenever the container restarts. Choose one:

1. **Compute Engine VM (simplest, keeps SQLite):** the VM's disk is persistent.
   - Create an e2-micro/e2-small Debian VM, open port 80/443 or use a reverse proxy (nginx/Caddy for HTTPS).
   - Install Node 22, copy the project, `npm ci --omit=dev`, set `JWT_SECRET`, run with `systemd` or `pm2`.
2. **Cloud Run + Cloud SQL (PostgreSQL) - the usual production setup:** needs `db.js` and the SQL in `server.js` ported from SQLite to PostgreSQL (the schema and queries are plain SQL, so the change is mechanical).
3. **Cloud Run for a short-lived demo only:** fine for a viva or demo where losing data on restart is acceptable.

### Cloud Run quick deploy (option 3, or after porting to Cloud SQL)

```bash
gcloud auth login
gcloud config set project YOUR_PROJECT_ID
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com

gcloud run deploy terraplan \
  --source . \
  --region asia-south1 \
  --allow-unauthenticated \
  --set-env-vars "JWT_SECRET=$(node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"),SEED_DEMO=true"
```

It prints an `https://...run.app` URL. Keep `JWT_SECRET` the same across deploys (use Secret Manager for anything beyond a demo), otherwise everyone is logged out.

Before sharing publicly: set `SEED_DEMO=false`, because the demo passwords are public in this README. Check current Google Cloud pricing and free-tier limits yourself, as they change.
