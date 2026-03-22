# Claude Manager — Dev Guide

Application locale de gestion d'instances Claude Code. Serveur Node.js + interface HTML/JS vanilla.

## Stack

- **Backend** : Node.js, Express, WebSocket (`ws`), pas de framework frontend
- **Frontend** : HTML/CSS/JS vanilla dans `public/index.html` — tout en un seul fichier
- **Persistance** : `config.json` à la racine (créé automatiquement au premier lancement)
- **Port** : 3131

## Lancer le projet

```bash
node server.js
# puis http://localhost:3131
```

## Architecture

```
claude-manager/
├── server.js          # Serveur Express + WebSocket + spawn des process claude
├── config.json        # Projets configurés + todos (auto-généré)
├── public/
│   └── index.html     # Tout le frontend (HTML + CSS + JS vanilla, fichier unique)
└── package.json
```

## Fonctionnement

### server.js
- `GET /api/config` — lire la config
- `POST /api/config` — sauvegarder projectsDir et/ou projects
- `GET /api/scan` — scanner projectsDir pour trouver les dossiers avec `.git`
- `POST /api/start/:projectId` — spawn `claude --dangerously-skip-permissions` dans le cwd du projet
- `POST /api/stop/:projectId` — kill le process
- `POST /api/send/:projectId` — écrire un prompt sur stdin du process claude
- `GET /api/logs/:projectId` — logs en mémoire (500 lignes max)
- `GET /api/status` — statut de tous les projets (`running` ou `idle`)
- CRUD todos : `GET/POST /api/todos/:projectId`, `PATCH/DELETE /api/todos/:projectId/:todoId`
- WebSocket : broadcast en temps réel des logs (`type: log`) et changements de statut (`type: status`)

### public/index.html
State global `state` :
```javascript
{
  projects: [],        // liste depuis config.json
  statuses: {},        // projectId -> 'running' | 'idle'
  logs: {},            // projectId -> [{text, type, ts}]
  todos: {},           // projectId -> [{id, text, done, createdAt}]
  activeProject: null, // id du projet affiché
  activeTab: 'logs',   // 'logs' | 'todos'
  scanResults: [],     // repos détectés lors du scan
  selectedScanItems: new Set(), // ids cochés dans la modal
  _editingProjects: [] // projets en cours d'édition dans la modal settings
}
```

Flux principal :
1. `init()` → charge config + statuts → `renderSidebar()` → `selectProject()`
2. `selectProject(id)` → charge logs + todos → `renderProjectView()`
3. WebSocket reçoit `log` → `appendLog()` / reçoit `status` → `updateSidebarItem()` + `updateProjectHeader()`

## Bug connu à corriger

`saveSettings()` ne rafraîchit pas la sidebar après enregistrement. Après `renderSidebar()`, ajouter :

```javascript
if (state.projects.length > 0) selectProject(state.projects[0].id);
```

La fonction complète corrigée :

```javascript
async function saveSettings() {
  const dir = document.getElementById('projectsDirInput').value.trim();
  await fetch('/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectsDir: dir, projects: state._editingProjects })
  });
  state.projects = [...state._editingProjects];
  const statuses = await fetch('/api/status').then(r => r.json());
  state.statuses = statuses;
  closeSettings();
  renderSidebar();
  if (state.projects.length > 0) selectProject(state.projects[0].id);
}
```

## Design system

Thème sombre, variables CSS dans `:root`. Couleurs principales :
- `--accent` : #f97316 (orange)
- `--green` : #22c55e (statut running)
- `--red` : #ef4444 (statut idle/stop)
- `--bg` / `--bg2` / `--bg3` : niveaux de fond
- `--muted` : texte secondaire

Police : Geist + Geist Mono (Google Fonts)

## Conventions

- Pas de framework, pas de bundler — JS vanilla pur
- Toute modification UI se fait dans `public/index.html`
- Toute modification API/process se fait dans `server.js`
- `config.json` ne pas commiter (contient les chemins locaux)
- Les logs sont en mémoire uniquement, non persistés entre redémarrages