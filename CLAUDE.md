# Claude Manager — Dev Guide

Application locale de gestion d'instances Claude Code. Serveur Node.js + interface HTML/JS vanilla.

## Stack

- **Backend** : Node.js, Express, WebSocket (`ws`)
- **Frontend** : HTML/CSS/JS vanilla dans `public/index.html` — tout en un seul fichier
- **Persistance** : `config.json` à la racine (créé automatiquement au premier lancement)
- **Dépendances** : `express`, `ws`, `dotenv`, `helmet`, `cors`, `express-rate-limit`
- **CDN frontend** : `marked.js` (rendu Markdown)

## Lancer le projet

```bash
node server.js
# puis http://localhost:3131
```

Variables d'environnement (ou `.env`) :

| Variable | Défaut | Description |
|----------|--------|-------------|
| `PORT` | 3131 | Port du serveur |
| `HOST` | 0.0.0.0 | Adresse d'écoute |
| `AUTH_SECRET` | _(vide)_ | Token d'authentification (désactivé si vide) |
| `SSL_CERT` | _(vide)_ | Chemin vers le certificat SSL |
| `SSL_KEY` | _(vide)_ | Chemin vers la clé SSL |

Si `SSL_CERT` et `SSL_KEY` sont fournis, le serveur démarre en HTTPS (fallback HTTP si erreur).

## Architecture

```
claude-manager/
├── server.js          # Serveur Express + WebSocket + spawn des process claude
├── config.json        # Projets + chats + todos (auto-généré, ne pas commiter)
├── public/
│   └── index.html     # Tout le frontend (HTML + CSS + JS, fichier unique)
├── package.json
└── .env               # Variables d'environnement (optionnel)
```

## API

### Authentification

Si `AUTH_SECRET` est défini, toutes les routes `/api/*` (sauf `POST /api/auth`) requièrent le header `X-Auth-Token` ou le query param `?token=`. La comparaison est en temps constant (`crypto.timingSafeEqual`).

| Méthode | Route | Description |
|---------|-------|-------------|
| GET | `/api/auth` | Vérifie si l'auth est requise |
| POST | `/api/auth` | Vérifie un token `{ token }` → `{ ok: true }` ou 401 |

### Config & scan

| Méthode | Route | Description |
|---------|-------|-------------|
| GET | `/api/config` | Lire la config |
| POST | `/api/config` | Sauvegarder projectsDir et/ou projects |
| GET | `/api/scan` | Scanner projectsDir pour les dossiers `.git` |
| POST | `/api/create-project` | Créer un dossier projet avec `git init` |

### Chats (multi-chat par projet)

| Méthode | Route | Description |
|---------|-------|-------------|
| GET | `/api/chats/:projectId` | Liste des chats d'un projet (avec statut) |
| POST | `/api/chats/:projectId` | Créer un nouveau chat |
| PATCH | `/api/chats/:projectId/:chatId` | Renommer un chat |
| DELETE | `/api/chats/:projectId/:chatId` | Supprimer un chat (kill le process si running) |

### Process Claude

| Méthode | Route | Description |
|---------|-------|-------------|
| POST | `/api/send/:projectId/:chatId` | Envoyer un prompt (spawn le process si nécessaire). Rate limited : 30 req/60s |
| POST | `/api/stop/:projectId/:chatId` | Kill le process Claude |
| GET | `/api/logs/:projectId/:chatId` | Logs en mémoire (500 lignes max) |
| GET | `/api/status` | Statut de tous les chats : `{ projectId: { chatId: 'running'\|'idle' } }` |

### Todos

| Méthode | Route | Description |
|---------|-------|-------------|
| GET | `/api/todos/:projectId` | Liste des todos |
| POST | `/api/todos/:projectId` | Créer un todo |
| PATCH | `/api/todos/:projectId/:todoId` | Modifier (done, text, waitForUser) |
| DELETE | `/api/todos/:projectId/:todoId` | Supprimer |
| POST | `/api/todos/:projectId/reorder` | Réordonner `{ ids: [...] }` |
| POST | `/api/todos/:projectId/bulk` | Import en masse (max 200 items) |

### Système

| Méthode | Route | Description |
|---------|-------|-------------|
| GET | `/api/health` | `{ status: 'ok', uptime }` |
| GET | `/api/version` | `{ version, hash, updateAvailable }` |
| POST | `/api/update` | Pull git + retourne la nouvelle version |

## WebSocket

Connexion sur le même port que le serveur HTTP. Si auth activée, token en query param `?token=`.

### Messages broadcast (JSON)

**Log :**
```json
{ "type": "log", "projectId": "...", "chatId": "...", "logType": "system|assistant|tool_use|stderr|prompt|result", "text": "...", "ts": 1234567890 }
```
Les messages `tool_use` incluent aussi `toolName` et `toolInput`.

**Status :**
```json
{ "type": "status", "projectId": "...", "chatId": "...", "status": "running|idle" }
```
Optionnel : `exitCode` sur les événements de fin de process.

À la connexion, le serveur envoie le statut initial de tous les chats.

## config.json

```json
{
  "projectsDir": "/home/user/projets",
  "projects": [
    {
      "id": "abc123",
      "name": "Mon Projet",
      "path": "/home/user/projets/mon-projet",
      "chats": [
        { "id": "1234567890", "name": "Chat 1", "createdAt": "...", "lastSessionId": "..." }
      ],
      "todos": [
        { "id": "...", "text": "...", "done": false, "createdAt": "...", "waitForUser": false }
      ]
    }
  ]
}
```

`lastSessionId` permet de reprendre une session Claude via le flag `--resume`.

## Frontend (public/index.html)

### State global

```javascript
{
  projects: [],              // liste depuis config.json
  statuses: {},              // { projectId: { chatId: 'running'|'idle' } }
  chats: {},                 // { projectId: [{ id, name, status }] }
  activeChat: {},            // { projectId: chatId } — chat actif par projet
  logs: {},                  // { "projectId:chatId": [{text, type, ts}] }
  todos: {},                 // { projectId: [{id, text, done, createdAt, waitForUser}] }
  activeProject: null,       // id du projet affiché
  activeTab: 'logs',         // 'logs' | 'todos'
  scanResults: [],           // repos détectés lors du scan
  selectedScanItems: Set,    // ids cochés dans la modal
  _todoQueue: null,          // { todos, currentIndex, projectId, chatId, paused }
  _statusWaiters: {},        // callbacks pour attendre le statut idle
  _queuedPrompt: null,       // prompt en attente (envoyé quand Claude passe idle)
  _editingProjects: []       // projets en édition dans la modal settings
}
```

### Flux principal

1. `checkAuthAndInit()` → vérifie le token → `showLogin()` ou `init()`
2. `init()` → charge config + statuts + chats → `renderSidebar()` → `connectWS()` → `checkVersion()` → `selectProject()`
3. `selectProject(id)` → charge logs + todos du chat actif → `renderProjectView()`
4. WebSocket reçoit `log` → `appendLog()` / reçoit `status` → met à jour sidebar + header + dot du chat

### Fonctionnalités clés

**Multi-chat** : Chaque projet a plusieurs chats indépendants. Barre de chats avec onglets, dot de statut, bouton + pour créer. Chaque chat a son propre process Claude, ses logs, et sa session persistante.

**File d'attente de todos** : `runAllTodos()` exécute les todos pendants séquentiellement. Utilise `waitForIdle()` (event-driven via WebSocket, pas de polling) pour attendre que Claude finisse. Le flag `waitForUser` pause la file et montre un champ de réponse.

**Prompt en attente** : Si on envoie un prompt pendant que Claude travaille, il est mis en file (`_queuedPrompt`) et envoyé automatiquement quand le statut passe à idle.

**Drag-and-drop** : Réorganisation des projets dans la sidebar et des todos par glisser-déposer.

**Import bulk** : Modal pour importer des todos en masse (un par ligne, nettoyage des préfixes markdown).

**Indicateur de réflexion** : Animation "Claude réfléchit..." avec timer mm:ss pendant le traitement.

**Rendu Markdown** : Les messages `assistant` sont rendus via `marked.js` avec `renderMd()`. Fallback en texte brut si marked n'est pas disponible.

**Toasts** : `showToast(message, type, duration)` pour les notifications (info, error, success).

**Version** : Affichage de la version dans la topbar, vérification auto des mises à jour, bouton "Update available".

**Mobile** : Sidebar toggle, overlay, layout responsive, confirmation tactile sur les boutons destructifs.

## Middleware

1. `helmet()` — headers de sécurité (CSP désactivé pour scripts inline)
2. `cors()` — autorise toutes les origines
3. `express.json()` — parsing JSON
4. `checkAuth()` — auth sur toutes les routes `/api/*`
5. `express.static('public')` — fichiers statiques
6. `rateLimit()` — 30 req/60s sur `/api/send` uniquement

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
- Les sessions Claude sont persistées via `lastSessionId` dans config.json
