require('dotenv').config();

const express = require('express');
const { WebSocketServer } = require('ws');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const app = express();

// ── Config from env ─────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT, 10) || 3131;
const HOST = process.env.HOST || '0.0.0.0';
const AUTH_SECRET = process.env.AUTH_SECRET || '';
const SSL_CERT = process.env.SSL_CERT || '';
const SSL_KEY = process.env.SSL_KEY || '';

// ── Create HTTP or HTTPS server ─────────────────────────────────────────────
let server;
if (SSL_CERT && SSL_KEY) {
  try {
    server = https.createServer({
      cert: fs.readFileSync(SSL_CERT),
      key: fs.readFileSync(SSL_KEY)
    }, app);
  } catch (e) {
    console.error(`[SSL] Failed to load certificates: ${e.message}`);
    console.error('[SSL] Falling back to HTTP');
    server = http.createServer(app);
  }
} else {
  server = http.createServer(app);
}

const wss = new WebSocketServer({ server });

// ── Security middleware ─────────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: false // allow inline scripts in index.html
}));

app.use(cors({
  origin: (origin, cb) => {
    // Allow same-origin requests (origin is undefined) and requests from the server itself
    if (!origin) return cb(null, true);
    cb(null, true); // In production behind a reverse proxy, tighten this
  }
}));

app.use(express.json());

// ── Authentication middleware ───────────────────────────────────────────────
function checkAuth(req, res, next) {
  if (!AUTH_SECRET) return next(); // No auth configured

  const token = req.headers['x-auth-token'] || req.query.token;
  if (token && crypto.timingSafeEqual(
    Buffer.from(token),
    Buffer.from(AUTH_SECRET)
  )) {
    return next();
  }
  res.status(401).json({ error: 'Unauthorized' });
}

// Serve static files (login page must be accessible without auth)
app.use(express.static(path.join(__dirname, 'public')));

// Auth check endpoint (no auth required — used by frontend to test token)
app.post('/api/auth', (req, res) => {
  if (!AUTH_SECRET) return res.json({ ok: true, authRequired: false });
  const token = req.body.token || '';
  if (token.length === AUTH_SECRET.length && crypto.timingSafeEqual(
    Buffer.from(token),
    Buffer.from(AUTH_SECRET)
  )) {
    return res.json({ ok: true });
  }
  res.status(401).json({ error: 'Invalid password' });
});

// Health check (no auth required)
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// Rate limit on /api/send to prevent prompt spam
const sendLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  message: { error: 'Too many requests, slow down' }
});

// ── Protect all other API routes ────────────────────────────────────────────
app.use('/api', checkAuth);

// Config file for persisting projects & todos
const CONFIG_FILE = path.join(__dirname, 'config.json');

let _configCache = null;
let _configMtime = 0;

function loadConfig() {
  if (!fs.existsSync(CONFIG_FILE)) {
    const defaults = {
      projectsDir: process.env.HOME + '/projets',
      projects: []
    };
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(defaults, null, 2));
    _configCache = defaults;
    _configMtime = fs.statSync(CONFIG_FILE).mtimeMs;
    return defaults;
  }
  const mtime = fs.statSync(CONFIG_FILE).mtimeMs;
  if (_configCache && mtime === _configMtime) {
    return _configCache;
  }
  _configCache = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  _configMtime = mtime;
  return _configCache;
}

function saveConfig(config) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
  _configCache = config;
  _configMtime = fs.statSync(CONFIG_FILE).mtimeMs;
}

// Active claude processes per project
const processes = {}; // projectId -> { proc, logs, status }

function broadcast(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(client => {
    if (client.readyState === 1) client.send(msg);
  });
}

function getProjectStatus(projectId) {
  const p = processes[projectId];
  if (!p) return 'idle';
  return p.status;
}

// Scan projects dir for git repos
app.get('/api/scan', (req, res) => {
  const config = loadConfig();
  const dir = config.projectsDir;
  if (!fs.existsSync(dir)) return res.json({ projects: [], dir });

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const repos = entries
    .filter(e => e.isDirectory())
    .filter(e => fs.existsSync(path.join(dir, e.name, '.git')))
    .map(e => ({
      id: e.name,
      name: e.name,
      path: path.join(dir, e.name)
    }));

  res.json({ projects: repos, dir });
});

app.get('/api/config', (req, res) => {
  res.json(loadConfig());
});

app.post('/api/config', (req, res) => {
  const config = loadConfig();
  if (req.body.projectsDir !== undefined) {
    const dir = req.body.projectsDir;
    if (!path.isAbsolute(dir)) {
      return res.status(400).json({ error: 'projectsDir must be an absolute path' });
    }
    if (!fs.existsSync(dir)) {
      return res.status(400).json({ error: 'projectsDir does not exist' });
    }
    config.projectsDir = dir;
  }
  if (req.body.projects) {
    for (const p of req.body.projects) {
      if (p.path && !path.isAbsolute(p.path)) {
        return res.status(400).json({ error: `Project path must be absolute: ${p.path}` });
      }
    }
    config.projects = req.body.projects;
  }
  saveConfig(config);
  res.json({ ok: true });
});

// Start claude in a project
// Helper: spawn claude with stream-json output
function spawnClaude(projectId, project, prompt) {
  // Load sessionId from config if not in memory
  if (!processes[projectId]?.sessionId) {
    try {
      const cfg = loadConfig();
      const proj = cfg.projects.find(p => p.id === projectId);
      if (proj?.lastSessionId) {
        if (!processes[projectId]) {
          processes[projectId] = { proc: null, logs: [], status: 'idle', sessionId: proj.lastSessionId, startedAt: new Date().toISOString() };
        } else {
          processes[projectId].sessionId = proj.lastSessionId;
        }
      }
    } catch (e) {
      console.error(`[${projectId}] Failed to load sessionId from config:`, e.message);
    }
  }

  const args = ['--print', '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions'];

  // Use --resume with session_id to continue the conversation
  if (processes[projectId] && processes[projectId].sessionId) {
    args.push('--resume', processes[projectId].sessionId);
  }

  const proc = spawn('claude', args, {
    cwd: project.path,
    env: { ...process.env },
    stdio: ['pipe', 'pipe', 'pipe']
  });

  // Send prompt via stdin and close it immediately
  proc.stdin.write(prompt);
  proc.stdin.end();

  proc.on('error', (err) => {
    console.error(`[${projectId}] Spawn error:`, err.message);
    if (processes[projectId]) {
      processes[projectId].status = 'idle';
      const entry = { logType: 'stderr', text: `Erreur: ${err.message}`, ts: Date.now() };
      processes[projectId].logs.push(entry);
      broadcast({ type: 'log', projectId, ...entry });
    }
    broadcast({ type: 'status', projectId, status: 'idle' });
  });

  console.log(`[${projectId}] Spawned claude in ${project.path}`);

  if (!processes[projectId]) {
    processes[projectId] = { proc, logs: [], status: 'running', sessionId: null, startedAt: new Date().toISOString() };
  } else {
    processes[projectId].proc = proc;
    processes[projectId].status = 'running';
  }

  let buffer = '';
  proc.stdout.on('data', (data) => {
    buffer += data.toString();
    // Parse complete JSON lines
    const lines = buffer.split('\n');
    buffer = lines.pop(); // keep incomplete line in buffer
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        const parsed = parseClaudeEvent(projectId, event);
        if (parsed) {
          processes[projectId].logs.push(parsed);
          if (processes[projectId].logs.length > 500) processes[projectId].logs.shift();
          broadcast({ type: 'log', projectId, ...parsed });
        }
      } catch (e) {
        console.log(`[${projectId}] JSON parse error:`, line.substring(0, 100));
      }
    }
  });

  proc.stderr.on('data', (data) => {
    const text = data.toString();
    console.log(`[${projectId}] STDERR:`, text.substring(0, 200));
    const entry = { logType: 'stderr', text, ts: Date.now() };
    processes[projectId].logs.push(entry);
    broadcast({ type: 'log', projectId, ...entry });
  });

  proc.on('exit', (code) => {
    console.log(`[${projectId}] EXIT code=${code}`);
    // Flush any remaining buffer
    if (buffer && buffer.trim()) {
      try {
        const event = JSON.parse(buffer);
        const parsed = parseClaudeEvent(projectId, event);
        if (parsed) {
          processes[projectId].logs.push(parsed);
          if (processes[projectId].logs.length > 500) processes[projectId].logs.shift();
          broadcast({ type: 'log', projectId, ...parsed });
        }
      } catch (e) {
        console.log(`[${projectId}] Final buffer parse error:`, buffer.substring(0, 100));
      }
    }
    if (processes[projectId]) processes[projectId].status = 'idle';
    broadcast({ type: 'status', projectId, status: 'idle', exitCode: code });
  });

  return proc;
}

// Parse a stream-json event into a log entry for the frontend
function parseClaudeEvent(projectId, event) {
  const ts = Date.now();

  if (event.type === 'system' && event.subtype === 'init') {
    const isResume = processes[projectId]?.sessionId != null;
    // Save session_id for --resume on next prompt
    if (event.session_id && processes[projectId]) {
      processes[projectId].sessionId = event.session_id;
      console.log(`[${projectId}] Session ID: ${event.session_id}`);
      // Persist sessionId in config for recovery after restart
      try {
        const cfg = loadConfig();
        const proj = cfg.projects.find(p => p.id === projectId);
        if (proj) {
          proj.lastSessionId = event.session_id;
          saveConfig(cfg);
        }
      } catch (e) {
        console.error(`[${projectId}] Failed to persist sessionId:`, e.message);
      }
    }
    if (isResume) return null; // Don't show init for resumed sessions
    return { logType: 'system', text: `Session démarrée (${event.model})`, ts };
  }

  if (event.type === 'assistant' && event.message?.content) {
    const parts = [];
    for (const block of event.message.content) {
      if (block.type === 'text' && block.text) {
        parts.push({ logType: 'assistant', text: block.text, ts });
      }
      if (block.type === 'tool_use') {
        const toolName = block.name;
        const input = block.input || {};
        let detail = '';
        if (toolName === 'Read') detail = input.file_path || '';
        else if (toolName === 'Edit') detail = input.file_path || '';
        else if (toolName === 'Write') detail = input.file_path || '';
        else if (toolName === 'Bash') detail = (input.command || '').substring(0, 100);
        else if (toolName === 'Grep') detail = input.pattern || '';
        else if (toolName === 'Glob') detail = input.pattern || '';
        else detail = JSON.stringify(input).substring(0, 100);

        parts.push({ logType: 'tool_use', text: `🔧 ${toolName}: ${detail}`, toolName, toolInput: input, ts });
      }
    }
    // Return first part, push rest directly
    if (parts.length > 1) {
      for (let i = 1; i < parts.length; i++) {
        processes[projectId].logs.push(parts[i]);
        if (processes[projectId].logs.length > 500) processes[projectId].logs.shift();
        broadcast({ type: 'log', projectId, ...parts[i] });
      }
    }
    return parts[0] || null;
  }

  if (event.type === 'result') {
    const duration = event.duration_ms ? `${(event.duration_ms / 1000).toFixed(1)}s` : '';
    return { logType: 'result', text: `✓ Terminé ${duration}`, ts };
  }

  return null;
}

app.post('/api/start/:projectId', (req, res) => {
  const { projectId } = req.params;
  const config = loadConfig();
  const project = config.projects.find(p => p.id === projectId);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  if (processes[projectId] && processes[projectId].status === 'running') {
    return res.json({ ok: true, message: 'Already running' });
  }

  // Initialize process entry without spawning — waits for first prompt
  processes[projectId] = {
    proc: null,
    logs: [],
    status: 'idle',
    startedAt: new Date().toISOString()
  };

  res.json({ ok: true });
});

// Stop a claude process
app.post('/api/stop/:projectId', (req, res) => {
  const { projectId } = req.params;
  const p = processes[projectId];
  if (p && p.proc) {
    p.proc.kill();
    p.status = 'idle';
  }
  broadcast({ type: 'status', projectId, status: 'idle' });
  res.json({ ok: true });
});

// Send a prompt to running claude
app.post('/api/send/:projectId', sendLimiter, (req, res) => {
  const { projectId } = req.params;
  const { prompt } = req.body;
  const config = loadConfig();
  const project = config.projects.find(p => p.id === projectId);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  if (processes[projectId] && processes[projectId].status === 'running') {
    return res.status(400).json({ error: 'Claude is already processing a prompt' });
  }

  // Log the user prompt
  if (!processes[projectId]) {
    processes[projectId] = { proc: null, logs: [], status: 'idle', startedAt: new Date().toISOString() };
  }
  processes[projectId].logs.push({ type: 'prompt', text: '> ' + prompt, ts: Date.now() });
  broadcast({ type: 'log', projectId, line: '> ' + prompt, logType: 'prompt' });

  // Set status to running immediately to prevent race conditions
  processes[projectId].status = 'running';
  broadcast({ type: 'status', projectId, status: 'running' });

  try {
    spawnClaude(projectId, project, prompt);
  } catch (e) {
    console.error(`[${projectId}] Failed to spawn claude:`, e.message);
    processes[projectId].status = 'idle';
    broadcast({ type: 'status', projectId, status: 'idle' });
    return res.status(500).json({ error: 'Failed to start Claude' });
  }

  res.json({ ok: true });
});

// Get logs for a project
app.get('/api/logs/:projectId', (req, res) => {
  const p = processes[req.params.projectId];
  res.json({ logs: p ? p.logs : [] });
});

// Status of all projects
app.get('/api/status', (req, res) => {
  const config = loadConfig();
  const statuses = {};
  config.projects.forEach(p => {
    statuses[p.id] = getProjectStatus(p.id);
  });
  res.json(statuses);
});

// Todos CRUD
app.get('/api/todos/:projectId', (req, res) => {
  const config = loadConfig();
  const project = config.projects.find(p => p.id === req.params.projectId);
  res.json({ todos: project ? (project.todos || []) : [] });
});

app.post('/api/todos/:projectId', (req, res) => {
  const config = loadConfig();
  const project = config.projects.find(p => p.id === req.params.projectId);
  if (!project) return res.status(404).json({ error: 'Not found' });
  if (!project.todos) project.todos = [];
  const todo = { id: Date.now().toString(), text: req.body.text, done: false, createdAt: new Date().toISOString() };
  project.todos.push(todo);
  saveConfig(config);
  res.json({ todo });
});

app.patch('/api/todos/:projectId/:todoId', (req, res) => {
  const config = loadConfig();
  const project = config.projects.find(p => p.id === req.params.projectId);
  if (!project) return res.status(404).json({ error: 'Not found' });
  const todo = (project.todos || []).find(t => t.id === req.params.todoId);
  if (!todo) return res.status(404).json({ error: 'Todo not found' });
  if (req.body.done !== undefined) todo.done = req.body.done;
  if (req.body.text !== undefined) todo.text = req.body.text;
  if (req.body.waitForUser !== undefined) todo.waitForUser = req.body.waitForUser;
  saveConfig(config);
  res.json({ todo });
});

app.post('/api/todos/:projectId/reorder', (req, res) => {
  const config = loadConfig();
  const project = config.projects.find(p => p.id === req.params.projectId);
  if (!project) return res.status(404).json({ error: 'Not found' });
  const order = req.body.order || [];
  const todosMap = new Map((project.todos || []).map(t => [t.id, t]));
  project.todos = order.map(id => todosMap.get(id)).filter(Boolean);
  // Append any todos not in the order list (safety)
  for (const t of todosMap.values()) {
    if (!order.includes(t.id)) project.todos.push(t);
  }
  saveConfig(config);
  res.json({ ok: true });
});

app.delete('/api/todos/:projectId/:todoId', (req, res) => {
  const config = loadConfig();
  const project = config.projects.find(p => p.id === req.params.projectId);
  if (!project) return res.status(404).json({ error: 'Not found' });
  project.todos = (project.todos || []).filter(t => t.id !== req.params.todoId);
  saveConfig(config);
  res.json({ ok: true });
});

// ── WebSocket with auth ─────────────────────────────────────────────────────
wss.on('connection', (ws, req) => {
  // Check auth for WebSocket connections
  if (AUTH_SECRET) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const token = url.searchParams.get('token') || '';
    if (token.length !== AUTH_SECRET.length || !crypto.timingSafeEqual(
      Buffer.from(token),
      Buffer.from(AUTH_SECRET)
    )) {
      ws.close(4001, 'Unauthorized');
      return;
    }
  }

  const config = loadConfig();
  // Send current state to new client
  config.projects.forEach(p => {
    ws.send(JSON.stringify({ type: 'status', projectId: p.id, status: getProjectStatus(p.id) }));
  });
});

// ── Start server ────────────────────────────────────────────────────────────
const protocol = SSL_CERT && SSL_KEY ? 'https' : 'http';
server.listen(PORT, HOST, () => {
  console.log(`Claude Manager running at ${protocol}://${HOST}:${PORT}`);
});
