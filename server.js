require('dotenv').config();

const express = require('express');
const { WebSocketServer } = require('ws');
const { spawn, execSync } = require('child_process');
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
    if (!origin) return cb(null, true);
    cb(null, true);
  }
}));

app.use(express.json());

// ── Authentication middleware ───────────────────────────────────────────────
function checkAuth(req, res, next) {
  if (!AUTH_SECRET) return next();
  const token = req.headers['x-auth-token'] || req.query.token;
  if (token && crypto.timingSafeEqual(
    Buffer.from(token),
    Buffer.from(AUTH_SECRET)
  )) {
    return next();
  }
  res.status(401).json({ error: 'Unauthorized' });
}

app.use(express.static(path.join(__dirname, 'public')));

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

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

const sendLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  message: { error: 'Too many requests, slow down' }
});

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

// ── Process management ──────────────────────────────────────────────────────
// Key: "projectId:chatId" -> { proc, logs, status, sessionId, chatId }
const processes = {};

function procKey(projectId, chatId) {
  return `${projectId}:${chatId}`;
}

function getProc(projectId, chatId) {
  return processes[procKey(projectId, chatId)] || null;
}

function broadcast(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(client => {
    if (client.readyState === 1) client.send(msg);
  });
}

function getChatStatus(projectId, chatId) {
  const p = getProc(projectId, chatId);
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

// ── Claude auth mode ────────────────────────────────────────────────────────
app.get('/api/claude-auth', (req, res) => {
  try {
    const hasApiKey = !!(process.env.ANTHROPIC_API_KEY);
    const mode = hasApiKey ? 'api_key' : 'subscription';
    const apiKeyPreview = hasApiKey && process.env.ANTHROPIC_API_KEY.length >= 8
      ? '...' + process.env.ANTHROPIC_API_KEY.slice(-8)
      : null;

    // Detect login status via ~/.claude credentials file (reliable, no CLI call)
    let loginStatus = 'unknown';
    try {
      const home = process.env.HOME || require('os').homedir();
      const credPaths = [
        path.join(home, '.claude', '.credentials.json'),
        path.join(home, '.config', 'claude', 'credentials.json'),
        path.join(home, '.claude.json')
      ];
      const hasCreds = credPaths.some(p => {
        try { return fs.existsSync(p) && fs.statSync(p).size > 0; }
        catch { return false; }
      });
      loginStatus = hasCreds ? 'logged_in' : 'not_logged_in';
    } catch (e) {
      loginStatus = 'unknown';
    }

    res.json({ mode, hasApiKey, loginStatus, apiKeyPreview });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/claude-auth', (req, res) => {
  const { mode, apiKey } = req.body;
  const envPath = path.join(__dirname, '.env');

  let envContent = '';
  if (fs.existsSync(envPath)) {
    envContent = fs.readFileSync(envPath, 'utf8');
  }

  if (mode === 'api_key') {
    if (!apiKey || !apiKey.startsWith('sk-ant-')) {
      return res.status(400).json({ error: 'Invalid API key format (must start with sk-ant-)' });
    }
    // Update or add ANTHROPIC_API_KEY in .env
    if (envContent.includes('ANTHROPIC_API_KEY=')) {
      envContent = envContent.replace(/ANTHROPIC_API_KEY=.*/g, `ANTHROPIC_API_KEY=${apiKey}`);
    } else {
      envContent += `\nANTHROPIC_API_KEY=${apiKey}\n`;
    }
    fs.writeFileSync(envPath, envContent);
    process.env.ANTHROPIC_API_KEY = apiKey;
    res.json({ ok: true, mode: 'api_key', needRestart: false });

  } else if (mode === 'subscription') {
    // Remove ANTHROPIC_API_KEY from .env
    if (envContent.includes('ANTHROPIC_API_KEY=')) {
      envContent = envContent.replace(/\n?ANTHROPIC_API_KEY=.*\n?/g, '\n');
      fs.writeFileSync(envPath, envContent.trim() + '\n');
    }
    delete process.env.ANTHROPIC_API_KEY;
    res.json({ ok: true, mode: 'subscription', needRestart: false });

  } else {
    res.status(400).json({ error: 'Invalid mode. Use "api_key" or "subscription"' });
  }
});

app.post('/api/claude-logout', (req, res) => {
  try {
    execSync('claude logout 2>&1 || true', { timeout: 5000 });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Create project ──────────────────────────────────────────────────────────
app.post('/api/create-project', (req, res) => {
  const config = loadConfig();
  const dir = config.projectsDir;
  if (!dir || !fs.existsSync(dir)) {
    return res.status(400).json({ error: 'projectsDir not configured or does not exist' });
  }

  const name = (req.body.name || '').trim();
  if (!name) {
    return res.status(400).json({ error: 'Project name is required' });
  }
  if (/[\/\\:*?"<>|]/.test(name)) {
    return res.status(400).json({ error: 'Project name contains invalid characters' });
  }

  const projectPath = path.join(dir, name);
  if (fs.existsSync(projectPath)) {
    return res.status(409).json({ error: 'A folder with this name already exists' });
  }

  try {
    fs.mkdirSync(projectPath, { recursive: true });
    execSync('git init', { cwd: projectPath, stdio: 'ignore' });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to create project: ' + err.message });
  }

  const project = { id: name, name, path: projectPath };
  config.projects = config.projects || [];
  config.projects.push(project);
  saveConfig(config);

  res.json({ ok: true, project });
});

// ── Chats CRUD ──────────────────────────────────────────────────────────────
app.get('/api/chats/:projectId', (req, res) => {
  const config = loadConfig();
  const project = config.projects.find(p => p.id === req.params.projectId);
  if (!project) return res.status(404).json({ error: 'Not found' });
  const chats = (project.chats || []).map(c => ({
    ...c,
    status: getChatStatus(req.params.projectId, c.id)
  }));
  res.json({ chats });
});

app.post('/api/chats/:projectId', (req, res) => {
  const config = loadConfig();
  const project = config.projects.find(p => p.id === req.params.projectId);
  if (!project) return res.status(404).json({ error: 'Not found' });
  if (!project.chats) project.chats = [];
  const chat = {
    id: Date.now().toString(),
    name: req.body.name || `Chat ${project.chats.length + 1}`,
    createdAt: new Date().toISOString()
  };
  project.chats.push(chat);
  saveConfig(config);
  res.json({ chat: { ...chat, status: 'idle' } });
});

app.delete('/api/chats/:projectId/:chatId', (req, res) => {
  const { projectId, chatId } = req.params;
  const config = loadConfig();
  const project = config.projects.find(p => p.id === projectId);
  if (!project) return res.status(404).json({ error: 'Not found' });
  // Kill process if running
  const key = procKey(projectId, chatId);
  if (processes[key] && processes[key].proc) {
    processes[key].proc.kill();
  }
  delete processes[key];
  project.chats = (project.chats || []).filter(c => c.id !== chatId);
  saveConfig(config);
  res.json({ ok: true });
});

app.patch('/api/chats/:projectId/:chatId', (req, res) => {
  const config = loadConfig();
  const project = config.projects.find(p => p.id === req.params.projectId);
  if (!project) return res.status(404).json({ error: 'Not found' });
  const chat = (project.chats || []).find(c => c.id === req.params.chatId);
  if (!chat) return res.status(404).json({ error: 'Chat not found' });
  if (req.body.name !== undefined) chat.name = req.body.name;
  saveConfig(config);
  res.json({ chat });
});

// ── Claude process spawn ────────────────────────────────────────────────────
function spawnClaude(projectId, chatId, project, prompt) {
  const key = procKey(projectId, chatId);

  // Load sessionId from config if not in memory
  if (!processes[key]?.sessionId) {
    try {
      const cfg = loadConfig();
      const proj = cfg.projects.find(p => p.id === projectId);
      const chat = (proj?.chats || []).find(c => c.id === chatId);
      if (chat?.lastSessionId) {
        if (!processes[key]) {
          processes[key] = { proc: null, logs: [], status: 'idle', sessionId: chat.lastSessionId, chatId, startedAt: new Date().toISOString() };
        } else {
          processes[key].sessionId = chat.lastSessionId;
        }
      }
    } catch (e) {
      console.error(`[${key}] Failed to load sessionId from config:`, e.message);
    }
  }

  const args = ['--print', '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions'];

  if (processes[key] && processes[key].sessionId) {
    args.push('--resume', processes[key].sessionId);
  }

  const proc = spawn('claude', args, {
    cwd: project.path,
    env: { ...process.env },
    stdio: ['pipe', 'pipe', 'pipe']
  });

  proc.stdin.write(prompt);
  proc.stdin.end();

  proc.on('error', (err) => {
    console.error(`[${key}] Spawn error:`, err.message);
    if (processes[key]) {
      processes[key].status = 'idle';
      const entry = { logType: 'stderr', text: `Error: ${err.message}`, ts: Date.now() };
      processes[key].logs.push(entry);
      broadcast({ type: 'log', projectId, chatId, ...entry });
    }
    broadcast({ type: 'status', projectId, chatId, status: 'idle' });
  });

  console.log(`[${key}] Spawned claude in ${project.path}`);

  if (!processes[key]) {
    processes[key] = { proc, logs: [], status: 'running', sessionId: null, chatId, startedAt: new Date().toISOString() };
  } else {
    processes[key].proc = proc;
    processes[key].status = 'running';
  }

  let buffer = '';
  proc.stdout.on('data', (data) => {
    buffer += data.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        const parsed = parseClaudeEvent(projectId, chatId, event);
        if (parsed) {
          processes[key].logs.push(parsed);
          if (processes[key].logs.length > 500) processes[key].logs.shift();
          broadcast({ type: 'log', projectId, chatId, ...parsed });
        }
      } catch (e) {
        console.log(`[${key}] JSON parse error:`, line.substring(0, 100));
      }
    }
  });

  proc.stderr.on('data', (data) => {
    const text = data.toString();
    console.log(`[${key}] STDERR:`, text.substring(0, 200));
    const entry = { logType: 'stderr', text, ts: Date.now() };
    processes[key].logs.push(entry);
    broadcast({ type: 'log', projectId, chatId, ...entry });
  });

  proc.on('exit', (code) => {
    console.log(`[${key}] EXIT code=${code}`);
    if (buffer && buffer.trim()) {
      try {
        const event = JSON.parse(buffer);
        const parsed = parseClaudeEvent(projectId, chatId, event);
        if (parsed) {
          processes[key].logs.push(parsed);
          if (processes[key].logs.length > 500) processes[key].logs.shift();
          broadcast({ type: 'log', projectId, chatId, ...parsed });
        }
      } catch (e) {
        console.log(`[${key}] Final buffer parse error:`, buffer.substring(0, 100));
      }
    }
    if (processes[key]) processes[key].status = 'idle';
    broadcast({ type: 'status', projectId, chatId, status: 'idle', exitCode: code });
  });

  return proc;
}

function parseClaudeEvent(projectId, chatId, event) {
  const key = procKey(projectId, chatId);
  const ts = Date.now();

  if (event.type === 'system' && event.subtype === 'init') {
    const isResume = processes[key]?.sessionId != null;
    if (event.session_id && processes[key]) {
      processes[key].sessionId = event.session_id;
      console.log(`[${key}] Session ID: ${event.session_id}`);
      try {
        const cfg = loadConfig();
        const proj = cfg.projects.find(p => p.id === projectId);
        const chat = (proj?.chats || []).find(c => c.id === chatId);
        if (chat) {
          chat.lastSessionId = event.session_id;
          saveConfig(cfg);
        }
      } catch (e) {
        console.error(`[${key}] Failed to persist sessionId:`, e.message);
      }
    }
    if (isResume) return null;
    return { logType: 'system', text: `Session started (${event.model})`, ts };
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
    if (parts.length > 1) {
      for (let i = 1; i < parts.length; i++) {
        processes[key].logs.push(parts[i]);
        if (processes[key].logs.length > 500) processes[key].logs.shift();
        broadcast({ type: 'log', projectId, chatId, ...parts[i] });
      }
    }
    return parts[0] || null;
  }

  if (event.type === 'result') {
    const duration = event.duration_ms ? `${(event.duration_ms / 1000).toFixed(1)}s` : '';
    if (processes[key]) processes[key].status = 'idle';
    broadcast({ type: 'status', projectId, chatId, status: 'idle' });
    return { logType: 'result', text: `✓ Done ${duration}`, ts };
  }

  return null;
}

// ── Stop a chat process ─────────────────────────────────────────────────────
app.post('/api/stop/:projectId/:chatId', (req, res) => {
  const { projectId, chatId } = req.params;
  const key = procKey(projectId, chatId);
  const p = processes[key];
  if (p && p.proc) {
    p.proc.kill();
    p.status = 'idle';
  }
  broadcast({ type: 'status', projectId, chatId, status: 'idle' });
  res.json({ ok: true });
});

// ── Send a prompt to a chat ─────────────────────────────────────────────────
app.post('/api/send/:projectId/:chatId', sendLimiter, (req, res) => {
  const { projectId, chatId } = req.params;
  const { prompt } = req.body;
  const config = loadConfig();
  const project = config.projects.find(p => p.id === projectId);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const key = procKey(projectId, chatId);

  if (processes[key] && processes[key].status === 'running') {
    return res.status(400).json({ error: 'Claude is already processing a prompt' });
  }

  if (!processes[key]) {
    processes[key] = { proc: null, logs: [], status: 'idle', chatId, startedAt: new Date().toISOString() };
  }
  processes[key].logs.push({ type: 'prompt', text: '> ' + prompt, ts: Date.now() });
  broadcast({ type: 'log', projectId, chatId, line: '> ' + prompt, logType: 'prompt' });

  processes[key].status = 'running';
  broadcast({ type: 'status', projectId, chatId, status: 'running' });

  try {
    spawnClaude(projectId, chatId, project, prompt);
  } catch (e) {
    console.error(`[${key}] Failed to spawn claude:`, e.message);
    processes[key].status = 'idle';
    broadcast({ type: 'status', projectId, chatId, status: 'idle' });
    return res.status(500).json({ error: 'Failed to start Claude' });
  }

  res.json({ ok: true });
});

// ── Get logs for a chat ─────────────────────────────────────────────────────
app.get('/api/logs/:projectId/:chatId', (req, res) => {
  const p = getProc(req.params.projectId, req.params.chatId);
  res.json({ logs: p ? p.logs : [] });
});

// ── Status of all chats for all projects ────────────────────────────────────
app.get('/api/status', (req, res) => {
  const config = loadConfig();
  const statuses = {};
  config.projects.forEach(p => {
    statuses[p.id] = {};
    (p.chats || []).forEach(c => {
      statuses[p.id][c.id] = getChatStatus(p.id, c.id);
    });
  });
  res.json(statuses);
});

// ── Todos CRUD (unchanged, per project) ─────────────────────────────────────
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
  for (const t of todosMap.values()) {
    if (!order.includes(t.id)) project.todos.push(t);
  }
  saveConfig(config);
  res.json({ ok: true });
});

app.post('/api/todos/:projectId/bulk', (req, res) => {
  const config = loadConfig();
  const project = config.projects.find(p => p.id === req.params.projectId);
  if (!project) return res.status(404).json({ error: 'Not found' });
  if (!project.todos) project.todos = [];
  const items = req.body.items;
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'items must be a non-empty array of strings' });
  }
  if (items.length > 200) {
    return res.status(400).json({ error: 'Maximum 200 items per import' });
  }
  const todos = items.map(text => ({
    id: (Date.now() + Math.random()).toString(),
    text: String(text).substring(0, 500),
    done: false,
    createdAt: new Date().toISOString()
  }));
  project.todos.push(...todos);
  saveConfig(config);
  res.json({ todos });
});

app.delete('/api/todos/:projectId/:todoId', (req, res) => {
  const config = loadConfig();
  const project = config.projects.find(p => p.id === req.params.projectId);
  if (!project) return res.status(404).json({ error: 'Not found' });
  project.todos = (project.todos || []).filter(t => t.id !== req.params.todoId);
  saveConfig(config);
  res.json({ ok: true });
});

// ── Version & Update ────────────────────────────────────────────────────────
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));

app.get('/api/version', async (req, res) => {
  let hash = null;
  let updateAvailable = false;

  // Get local git hash
  try {
    hash = execSync('git rev-parse HEAD', { cwd: __dirname }).toString().trim().substring(0, 7);
  } catch (e) { /* not a git repo */ }

  // Method 1: git fetch + compare hashes
  try {
    execSync('git fetch --quiet', { cwd: __dirname, timeout: 10000 });
    const localHash = execSync('git rev-parse HEAD', { cwd: __dirname }).toString().trim();
    const remoteHash = execSync('git rev-parse origin/main', { cwd: __dirname }).toString().trim();
    if (localHash !== remoteHash) updateAvailable = true;
  } catch (e) { /* fetch failed, try method 2 */ }

  // Method 2: check remote package.json version via GitHub API
  if (!updateAvailable) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      const r = await fetch('https://raw.githubusercontent.com/AytoKyto/maker-copilot/main/package.json', { signal: controller.signal });
      clearTimeout(timeout);
      if (r.ok) {
        const remotePkg = await r.json();
        if (remotePkg.version && remotePkg.version !== pkg.version) {
          updateAvailable = true;
        }
      }
    } catch (e) { /* no network — ignore */ }
  }

  res.json({ version: pkg.version, hash, updateAvailable });
});

app.post('/api/update', (req, res) => {
  try {
    const output = execSync('git pull --ff-only 2>&1', { cwd: __dirname, timeout: 30000 }).toString();
    const newPkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
    res.json({ ok: true, output, version: newPkg.version, needRestart: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── WebSocket with auth ─────────────────────────────────────────────────────
wss.on('connection', (ws, req) => {
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
  config.projects.forEach(p => {
    (p.chats || []).forEach(c => {
      ws.send(JSON.stringify({ type: 'status', projectId: p.id, chatId: c.id, status: getChatStatus(p.id, c.id) }));
    });
  });
});

// ── Start server ────────────────────────────────────────────────────────────
const protocol = SSL_CERT && SSL_KEY ? 'https' : 'http';
server.listen(PORT, HOST, () => {
  console.log(`Claude Manager running at ${protocol}://${HOST}:${PORT}`);
});
