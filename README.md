# IntakeHive — Backend API

A lightweight **Node.js + Express** backend with a **SQLite** database for the IntakeHive lead capture website.

---

## What's included

| File | Purpose |
|------|---------|
| `server.js` | Express API server |
| `admin.html` | Updated admin dashboard (pulls from API, not localStorage) |
| `.env.example` | Environment variables template |
| `data/intakehive.db` | SQLite database (auto-created on first run) |

---

## Quick Start

### 1. Install dependencies
```bash
npm install
```

### 2. Configure environment
```bash
cp .env.example .env
# Edit .env — at minimum change ADMIN_KEY
```

### 3. Start the server
```bash
npm start
# or for development with auto-reload:
npm run dev
```

The API runs at **http://localhost:3001**.

---

## API Endpoints

### Public

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/leads` | Submit a new lead (rate-limited: 30/15min per IP) |
| `GET` | `/api/health` | Health check |

**POST /api/leads** — Request body:
```json
{
  "tort":      "talcum",
  "firstName": "Jane",
  "lastName":  "Smith",
  "phone":     "(555) 123-4567",
  "email":     "jane@example.com",
  "state":     "CA",
  "diagnosis": "Ovarian Cancer",
  "diagYear":  "2022"
}
```

Valid `tort` values: `talcum`, `roundup`, `paraquat`, `depo`, `asbestos`, `cgm`

---

### Admin (require `x-admin-key` header)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/leads` | List leads with pagination, search & filter |
| `GET` | `/api/leads/export` | Download all leads as CSV |
| `GET` | `/api/leads/:id` | Get single lead |
| `DELETE` | `/api/leads/:id` | Delete a lead |
| `GET` | `/api/stats` | Dashboard aggregate stats |

**Query params for GET /api/leads:**
- `search` — searches name, email, phone, diagnosis
- `tort` — filter by tort type
- `state` — filter by US state
- `page` (default: 1), `limit` (default: 50, max: 200)
- `sort` (default: `created_at`), `order` (`asc`/`desc`)

---

## Environment Variables

```env
PORT=3001                          # Server port
ADMIN_KEY=IntakeHive2026           # Change this — used for all admin endpoints
ALLOWED_ORIGINS=https://yourdomain.com  # CORS: leave blank in dev for all origins
```

---

## Connecting the Frontend

In `index.html`, the `API_URL` constant points to your backend:

```js
const API_URL = 'http://localhost:3001'; // ← change to your deployed URL
```

In `admin.html`, update both `API_URL` and `ADMIN_PW` to match your `.env`.

---

## Deployment

### Option A — Railway / Render / Fly.io (recommended)

1. Push this folder to a GitHub repo
2. Connect to Railway/Render — it auto-detects `package.json`
3. Set environment variables in the dashboard
4. Your API URL becomes something like `https://intakehive.railway.app`
5. Update `API_URL` in both HTML files

### Option B — Vercel (static frontend) + Railway (backend)

> **Note:** Vercel runs serverless functions and does not support long-running Node processes or persistent file storage. It is best used for hosting the **static HTML files only**. The `server.js` backend must run separately on Railway, Render, or a VPS.

**Step 1 — Deploy the backend on Railway:**
```bash
# 1. Push this entire folder to a GitHub repo
# 2. Go to https://railway.app → New Project → Deploy from GitHub repo
# 3. Set environment variables in Railway dashboard:
#    PORT=3001
#    ADMIN_KEY=your-secret-key
#    ALLOWED_ORIGINS=https://your-vercel-app.vercel.app
# 4. Copy your Railway public URL (e.g. https://intakehive.up.railway.app)
```

**Step 2 — Deploy the frontend on Vercel:**
```bash
# 1. Update API_URL in index.html and admin.html to your Railway URL
#    const API_URL = 'https://intakehive.up.railway.app';
# 2. Go to https://vercel.com → New Project → Import your GitHub repo
# 3. Set Root Directory to this folder (or repo root)
# 4. Vercel will serve index.html and admin.html as static files
# 5. Your site is live at https://your-app.vercel.app
```

### Option C — VPS (DigitalOcean, Linode, etc.)

```bash
# On your server:
git clone <your-repo>
cd intakehive-backend
npm install
cp .env.example .env && nano .env

# With PM2 (recommended)
npm install -g pm2
pm2 start server.js --name intakehive
pm2 save && pm2 startup

# Nginx reverse proxy (port 3001 → 443)
# Set ALLOWED_ORIGINS=https://yourdomain.com in .env
```

---

## Accessing the Admin Dashboard

After deployment, the admin panel is a static HTML file — **it is not served by the Express API**. Access it one of these ways:

### Option A — Open locally
```bash
# Just open admin.html directly in your browser:
open admin.html          # macOS
start admin.html         # Windows
xdg-open admin.html      # Linux
```
Before opening, make sure `API_URL` at the top of `admin.html` points to your deployed backend URL.

### Option B — Serve alongside frontend (Vercel / static host)
If you deployed `index.html` via Vercel or Netlify, upload `admin.html` to the same project. It will be accessible at:
```
https://your-app.vercel.app/admin.html
```
**Security tip:** Rename it to something less obvious (e.g. `dashboard-a3f9.html`) since the password gate in the file is client-side only. Do not rely on the filename being secret — set a strong `ADMIN_KEY` in your `.env`.

### Option C — Serve via Express (self-hosted)
Add this line to `server.js` before the routes to serve both files from the same server:
```js
app.use(express.static(__dirname)); // serves index.html and admin.html
```
Then access at:
```
https://yourdomain.com/admin.html
```

---

## Database

- SQLite file at `data/intakehive.db` — auto-created on first start
- No external database service needed
- For high-volume production use, swap `sql.js` for **Supabase** or **PlanetScale** (PostgreSQL/MySQL)

### Backup
```bash
cp data/intakehive.db data/intakehive_backup_$(date +%Y%m%d).db
```

---

## Security Notes

- Change `ADMIN_KEY` in `.env` before deploying
- Set `ALLOWED_ORIGINS` to your exact domain in production
- The rate limiter blocks 30+ submissions per IP per 15 min
- All admin routes require `x-admin-key` header
- Input is validated and sanitized server-side

---

*© 2026 IntakeHive. All Rights Reserved.*
