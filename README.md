<p align="center">
  <img src="https://img.shields.io/badge/node-%3E%3D18-339933?logo=node.js&logoColor=white" alt="Node.js">
  <img src="https://img.shields.io/badge/claude--code-required-f97316?logo=anthropic&logoColor=white" alt="Claude Code">
  <img src="https://img.shields.io/badge/license-ISC-blue" alt="License">
  <img src="https://img.shields.io/badge/zero-dependencies_frontend-1a1a1e" alt="No framework">
</p>

<h1 align="center">
  <br>
  Claude Manager
  <br>
</h1>

<p align="center">
  <b>A self-hosted dashboard to manage multiple Claude Code instances from a single UI.</b>
  <br>
  Spawn, monitor, and interact with Claude across all your projects — in real time.
</p>

<p align="center">
  <a href="#features">Features</a> &bull;
  <a href="#quick-start">Quick Start</a> &bull;
  <a href="#installation">Installation</a> &bull;
  <a href="#deploy-on-a-vps">VPS Deploy</a> &bull;
  <a href="#configuration">Configuration</a> &bull;
  <a href="#architecture">Architecture</a> &bull;
  <a href="#security">Security</a> &bull;
  <a href="#contributing">Contributing</a>
</p>

---

## Features

- **Multi-project dashboard** — Switch between projects in one click from the sidebar
- **Real-time logs** — WebSocket-powered live streaming of Claude's output with Markdown rendering
- **Todo queue** — Create task lists per project, run them sequentially, pause between tasks
- **Session persistence** — Conversations survive server restarts via `--resume`
- **Auto-scan** — Detects git repositories in your projects directory
- **Authentication** — Optional password protection with rate limiting
- **HTTPS support** — SSL/TLS with automatic HTTP fallback
- **Drag & drop** — Reorder projects and todos
- **Mobile responsive** — Works on phone and tablet
- **Zero frontend dependencies** — Pure vanilla HTML/CSS/JS, no build step

## Quick Start

```bash
git clone https://github.com/mathmusic57/claude-manager.git
cd claude-manager
npm install
node server.js
```

Open **http://localhost:3131** and configure your projects directory.

## Installation

### One-line install (Linux / macOS)

```bash
curl -sL https://raw.githubusercontent.com/mathmusic57/claude-manager/main/install.sh | bash
```

The install script will:
1. Check for Node.js >= 18 and git
2. Install Claude Code globally if missing
3. Clone the repository to `~/claude-manager`
4. Prompt for password, port, projects directory, and API key
5. Create a systemd service on Linux (optional)

### Manual install

```bash
git clone https://github.com/mathmusic57/claude-manager.git ~/claude-manager
cd ~/claude-manager
npm install
cp .env.example .env  # edit with your values
node server.js
```

### Uninstall

```bash
bash ~/claude-manager/uninstall.sh
```

---

## Deploy on a VPS

Full step-by-step guide to deploy Claude Manager on a fresh VPS.

### Minimum VPS specs

| Resource | Minimum | Recommended | Notes |
|---|---|---|---|
| **CPU** | 1 vCPU | 2 vCPU | Each Claude process is I/O-bound (API calls), not CPU-heavy |
| **RAM** | 1 GB | 2 GB | Node.js ~80 MB + ~150 MB per claude process |
| **Disk** | 10 GB | 20 GB | Node.js, Claude Code, your project repos |
| **OS** | Ubuntu 22.04 | Ubuntu 24.04 / Debian 12 | Any Linux with systemd works |
| **Network** | Open port 80+443 | — | For Caddy HTTPS reverse proxy |

> Running 3-5 projects concurrently works fine on a 2 GB VPS. For 10+ simultaneous Claude instances, go with 4 GB.

### Step 1 — Connect and update

```bash
ssh root@YOUR_VPS_IP

apt update && apt upgrade -y
```

### Step 2 — Create a non-root user (recommended)

```bash
adduser claude
usermod -aG sudo claude
su - claude
```

### Step 3 — Install Node.js 20

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
node -v  # should print v20.x
```

### Step 4 — Install Claude Code

```bash
sudo npm install -g @anthropic-ai/claude-code
claude --version
```

### Step 5 — Install Claude Manager

**Option A — One-line installer** (interactive, sets up everything):

```bash
curl -sL https://raw.githubusercontent.com/mathmusic57/claude-manager/main/install.sh | bash
```

**Option B — Manual**:

```bash
git clone https://github.com/mathmusic57/claude-manager.git ~/claude-manager
cd ~/claude-manager
npm install
```

Create the `.env`:

```bash
cat > ~/claude-manager/.env << 'EOF'
PORT=3131
HOST=127.0.0.1
AUTH_SECRET=change-me-to-a-strong-password
ANTHROPIC_API_KEY=sk-ant-your-key-here
EOF
```

> `HOST=127.0.0.1` because Caddy will proxy — no need to expose Node.js directly.

### Step 6 — Systemd service

```bash
sudo tee /etc/systemd/system/claude-manager.service > /dev/null << EOF
[Unit]
Description=Claude Manager
After=network.target

[Service]
Type=simple
User=claude
WorkingDirectory=/home/claude/claude-manager
ExecStart=/usr/bin/node server.js
Restart=on-failure
RestartSec=5
EnvironmentFile=/home/claude/claude-manager/.env
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable claude-manager
sudo systemctl start claude-manager
```

Check it's running:

```bash
sudo systemctl status claude-manager
curl -s http://127.0.0.1:3131/api/health
# → {"status":"ok","uptime":...}
```

### Step 7 — HTTPS with Caddy (reverse proxy)

Caddy auto-provisions Let's Encrypt certificates with zero config.

```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update
sudo apt install caddy
```

Edit the Caddyfile:

```bash
sudo tee /etc/caddy/Caddyfile > /dev/null << 'EOF'
claude.yourdomain.com {
    reverse_proxy 127.0.0.1:3131
}
EOF

sudo systemctl restart caddy
```

> Point your domain's DNS A record to your VPS IP first. Caddy handles SSL automatically.

### Step 8 — Firewall

```bash
sudo apt install -y ufw
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow ssh
sudo ufw allow 80
sudo ufw allow 443
sudo ufw enable
```

> Port 3131 is **not** opened — only Caddy (80/443) is exposed to the internet.

### Step 9 — Clone your projects

```bash
mkdir -p ~/projets
cd ~/projets
git clone git@github.com:you/your-project.git
```

Then open `https://claude.yourdomain.com`, log in with your `AUTH_SECRET`, and scan the `~/projets` directory.

### Useful commands

```bash
# Logs
sudo journalctl -u claude-manager -f

# Restart after .env change
sudo systemctl restart claude-manager

# Update to latest version
cd ~/claude-manager && git pull && npm install
sudo systemctl restart claude-manager

# Check resource usage
htop
```

### VPS providers reference

Any provider works. Some starting points:

| Provider | Cheapest viable plan | RAM | Price/month |
|---|---|---|---|
| Hetzner | CX22 | 2 GB | ~4 EUR |
| Contabo | VPS S | 8 GB | ~6 EUR |
| OVH | Starter | 2 GB | ~4 EUR |
| DigitalOcean | Basic | 2 GB | $12 |
| Vultr | Cloud Compute | 2 GB | $10 |

---

## Configuration

Create a `.env` file at the project root:

```env
# Server
PORT=3131
HOST=0.0.0.0

# Authentication (leave empty to disable)
AUTH_SECRET=your-secret-password

# Anthropic API key (required by Claude Code)
ANTHROPIC_API_KEY=sk-ant-...

# SSL/TLS (leave empty if behind a reverse proxy)
SSL_CERT=/path/to/cert.pem
SSL_KEY=/path/to/key.pem
```

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3131` | Server port |
| `HOST` | `0.0.0.0` | Bind address |
| `AUTH_SECRET` | *(empty)* | Password for the web UI. Empty = no auth |
| `ANTHROPIC_API_KEY` | *(required)* | Your Anthropic API key |
| `SSL_CERT` | *(empty)* | Path to SSL certificate. Falls back to HTTP on error |
| `SSL_KEY` | *(empty)* | Path to SSL private key |

## Usage

### 1. Add projects

Click **config** in the top bar, enter your projects parent directory (e.g. `~/projects`), hit **scan** to detect git repos, select the ones you want, and save.

### 2. Send prompts

Select a project in the sidebar, type a prompt in the input bar, and press Enter. Claude runs with `--dangerously-skip-permissions` and streams output in real time.

### 3. Todo queue

Switch to the **todos** tab to create a task list. You can:

- **Send individually** — click the arrow button on any todo
- **Run all** — execute all pending todos sequentially
- **Pause points** — click the pause icon on a todo to make the queue wait for your input after that task
- **Respond mid-queue** — when paused, send a follow-up message before continuing

### 4. Session resume

Claude Manager persists session IDs. When you send a new prompt to a project, it automatically resumes the previous conversation context.

## Architecture

```
claude-manager/
├── server.js            # Express + WebSocket server, spawns claude processes
├── public/
│   └── index.html       # Entire frontend — HTML + CSS + JS in one file
├── config.json          # Projects & todos (auto-generated, gitignored)
├── install.sh           # One-line installer
├── uninstall.sh         # Clean uninstaller
├── start.sh             # Quick launcher
├── package.json
└── .env                 # Environment config (gitignored)
```

### API

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/auth` | Verify password |
| `GET` | `/api/config` | Read configuration |
| `POST` | `/api/config` | Update projects directory and project list |
| `GET` | `/api/scan` | Scan for git repositories |
| `POST` | `/api/start/:id` | Initialize a project slot |
| `POST` | `/api/stop/:id` | Kill a running claude process |
| `POST` | `/api/send/:id` | Send a prompt (spawns claude with `--print`) |
| `GET` | `/api/logs/:id` | Get in-memory logs (500 lines max) |
| `GET` | `/api/status` | Get status of all projects |
| `GET/POST/PATCH/DELETE` | `/api/todos/:id` | CRUD operations on todos |
| `POST` | `/api/todos/:id/reorder` | Reorder todos via drag & drop |

### WebSocket

Connects automatically on page load. Broadcasts:
- `{ type: 'log', projectId, text, logType }` — real-time log entries
- `{ type: 'status', projectId, status }` — process state changes

## Security

- **Authentication** — Token-based with `crypto.timingSafeEqual` to prevent timing attacks
- **Rate limiting** — 30 requests/minute on prompt sending
- **Helmet** — HTTP security headers enabled
- **XSS protection** — All user input is HTML-escaped before rendering
- **Markdown sanitization** — HTML is escaped before Markdown parsing
- **Path validation** — Only absolute, existing paths are accepted for project directories
- **CORS** — Configurable origin policy

> **Note:** Claude runs with `--dangerously-skip-permissions`. This is by design for automation, but means Claude can execute any command on your machine. Run this on a trusted network or behind a reverse proxy with proper auth.

## Prerequisites

- **Node.js** >= 18
- **Claude Code** CLI installed and in PATH (`npm install -g @anthropic-ai/claude-code`)
- A valid **Anthropic API key**

## Contributing

Contributions are welcome! The project is intentionally minimal:

- **Frontend** — Everything lives in `public/index.html`. Vanilla JS, no framework, no bundler.
- **Backend** — Everything lives in `server.js`. Express + `ws`, no ORM, no database.
- **No build step** — Edit, save, refresh.

```bash
# Dev workflow
node server.js
# Open http://localhost:3131
# Edit files, refresh browser
```

## License

ISC
