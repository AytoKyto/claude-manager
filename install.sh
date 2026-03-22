#!/usr/bin/env bash
set -e

# ── Claude Manager — Script d'installation ──────────────────────────────────
# Usage : curl -sL <url>/install.sh | bash
# Ou   : bash install.sh
#
# Installe claude-manager + Claude Code sur un serveur Linux/macOS,
# configure un mot de passe, crée un service systemd, et lance le tout.
# ─────────────────────────────────────────────────────────────────────────────

REPO="https://github.com/AytoKyto/claude-manager.git"
INSTALL_DIR="$HOME/claude-manager"
SERVICE_NAME="claude-manager"

# ── Couleurs ─────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
ORANGE='\033[0;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

info()  { echo -e "${CYAN}▸${NC} $1"; }
ok()    { echo -e "${GREEN}✓${NC} $1"; }
warn()  { echo -e "${ORANGE}⚠${NC} $1"; }
fail()  { echo -e "${RED}✗${NC} $1"; exit 1; }

echo ""
echo -e "${ORANGE}${BOLD}  ⌘ Claude Manager — Installation${NC}"
echo -e "  ──────────────────────────────────"
echo ""

# ── 1. Vérifier Node.js ─────────────────────────────────────────────────────
if command -v node &>/dev/null; then
  NODE_VERSION=$(node -v | sed 's/v//')
  NODE_MAJOR=$(echo "$NODE_VERSION" | cut -d. -f1)
  if [ "$NODE_MAJOR" -lt 18 ]; then
    fail "Node.js >= 18 requis (trouvé v$NODE_VERSION). Installe via https://nodejs.org"
  fi
  ok "Node.js v$NODE_VERSION"
else
  fail "Node.js non trouvé. Installe via https://nodejs.org ou :\n   curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt install -y nodejs"
fi

# ── 2. Vérifier git ─────────────────────────────────────────────────────────
if ! command -v git &>/dev/null; then
  fail "git non trouvé. Installe-le : sudo apt install git"
fi
ok "git"

# ── 3. Installer Claude Code si absent ───────────────────────────────────────
if command -v claude &>/dev/null; then
  ok "Claude Code $(claude --version 2>/dev/null | head -1)"
else
  info "Installation de Claude Code..."
  npm install -g @anthropic-ai/claude-code
  if command -v claude &>/dev/null; then
    ok "Claude Code installé"
  else
    fail "Impossible d'installer Claude Code. Essaie : sudo npm install -g @anthropic-ai/claude-code"
  fi
fi

# ── 4. Cloner ou mettre à jour le repo ───────────────────────────────────────
if [ -d "$INSTALL_DIR/.git" ]; then
  info "Mise à jour de claude-manager..."
  cd "$INSTALL_DIR"
  git pull --ff-only || warn "git pull a échoué, on continue avec la version actuelle"
else
  if [ -d "$INSTALL_DIR" ]; then
    warn "$INSTALL_DIR existe déjà mais n'est pas un repo git"
    warn "On l'utilise tel quel"
  else
    info "Clonage du repo..."
    git clone "$REPO" "$INSTALL_DIR"
  fi
  cd "$INSTALL_DIR"
fi
ok "claude-manager dans $INSTALL_DIR"

# ── 5. npm install ───────────────────────────────────────────────────────────
info "Installation des dépendances..."
npm install --production
ok "Dépendances installées"

# ── 6. Configuration .env ────────────────────────────────────────────────────
if [ -f "$INSTALL_DIR/.env" ]; then
  warn "Fichier .env existant conservé"
else
  info "Configuration..."
  echo ""

  # Mot de passe
  echo -e "${BOLD}Mot de passe pour l'interface web${NC} (laisser vide = pas d'auth) :"
  read -rsp "  > " AUTH_PW
  echo ""

  # Port
  echo -e "${BOLD}Port${NC} [3131] :"
  read -rp "  > " CUSTOM_PORT
  CUSTOM_PORT=${CUSTOM_PORT:-3131}

  # Dossier projets
  echo -e "${BOLD}Dossier parent des projets${NC} [$HOME/projets] :"
  read -rp "  > " PROJECTS_DIR
  PROJECTS_DIR=${PROJECTS_DIR:-$HOME/projets}

  # Clé API Anthropic
  echo ""
  echo -e "${BOLD}Comment utilises-tu Claude ?${NC}"
  echo -e "  1) Abonnement Claude (Max/Pro) — authentification via ${CYAN}claude login${NC}"
  echo -e "  2) Clé API Anthropic (ANTHROPIC_API_KEY)"
  read -rp "  > [1/2] " AUTH_MODE
  AUTH_MODE=${AUTH_MODE:-1}

  API_KEY=""
  if [ "$AUTH_MODE" = "2" ]; then
    echo -e "${BOLD}ANTHROPIC_API_KEY${NC} :"
    read -rsp "  > " API_KEY
    echo ""
  fi

  cat > "$INSTALL_DIR/.env" <<EOF
PORT=$CUSTOM_PORT
HOST=0.0.0.0
AUTH_SECRET=$AUTH_PW
ANTHROPIC_API_KEY=$API_KEY

# SSL (laisser vide si derrière un reverse proxy comme nginx/caddy)
SSL_CERT=
SSL_KEY=
EOF

  # Créer le dossier projets s'il n'existe pas
  mkdir -p "$PROJECTS_DIR"

  ok "Configuration sauvée dans .env"

  # Si abonnement, lancer claude login
  if [ "$AUTH_MODE" = "1" ]; then
    echo ""
    info "Authentification avec ton compte Anthropic..."
    info "Un lien va s'ouvrir — connecte-toi dans ton navigateur."
    echo ""
    claude login
    if [ $? -eq 0 ]; then
      ok "Authentification réussie"
    else
      warn "Authentification échouée — tu pourras relancer 'claude login' plus tard"
    fi
  fi
fi

# ── 7. Service systemd (Linux uniquement) ────────────────────────────────────
if [[ "$(uname)" == "Linux" ]] && command -v systemctl &>/dev/null; then
  echo ""
  echo -e "${BOLD}Créer un service systemd ?${NC} (lance au démarrage) [O/n] :"
  read -rp "  > " SETUP_SERVICE
  SETUP_SERVICE=${SETUP_SERVICE:-O}

  if [[ "$SETUP_SERVICE" =~ ^[OoYy]$ ]]; then
    SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"

    # Charger le port depuis .env
    SVC_PORT=$(grep '^PORT=' "$INSTALL_DIR/.env" | cut -d= -f2)
    SVC_PORT=${SVC_PORT:-3131}

    sudo tee "$SERVICE_FILE" > /dev/null <<EOF
[Unit]
Description=Claude Manager
After=network.target

[Service]
Type=simple
User=$USER
WorkingDirectory=$INSTALL_DIR
ExecStart=$(which node) server.js
Restart=on-failure
RestartSec=5
EnvironmentFile=$INSTALL_DIR/.env
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF

    sudo systemctl daemon-reload
    sudo systemctl enable "$SERVICE_NAME"
    sudo systemctl restart "$SERVICE_NAME"
    ok "Service systemd créé et démarré"

    # Vérifier que ça tourne
    sleep 2
    if systemctl is-active --quiet "$SERVICE_NAME"; then
      ok "claude-manager tourne"
    else
      warn "Le service ne semble pas actif. Vérifie : journalctl -u $SERVICE_NAME -f"
    fi
  fi
else
  if [[ "$(uname)" == "Darwin" ]]; then
    info "macOS détecté — pas de service systemd."
    info "Lance manuellement : cd $INSTALL_DIR && node server.js"
  fi
fi

# ── 8. Résumé ────────────────────────────────────────────────────────────────
SVC_PORT=$(grep '^PORT=' "$INSTALL_DIR/.env" 2>/dev/null | cut -d= -f2)
SVC_PORT=${SVC_PORT:-3131}
HAS_AUTH=$(grep '^AUTH_SECRET=' "$INSTALL_DIR/.env" 2>/dev/null | cut -d= -f2)

echo ""
echo -e "${GREEN}${BOLD}  ✓ Installation terminée !${NC}"
echo -e "  ──────────────────────────────────"
echo -e "  ${BOLD}URL :${NC}          http://$(hostname -I 2>/dev/null | awk '{print $1}' || echo 'localhost'):${SVC_PORT}"
if [ -n "$HAS_AUTH" ]; then
  echo -e "  ${BOLD}Auth :${NC}         activée"
else
  echo -e "  ${BOLD}Auth :${NC}         ${RED}désactivée${NC} (ajouter AUTH_SECRET dans .env)"
fi
echo -e "  ${BOLD}Config :${NC}       $INSTALL_DIR/.env"
echo -e "  ${BOLD}Logs :${NC}         journalctl -u $SERVICE_NAME -f"
echo -e "  ${BOLD}Redémarrer :${NC}   sudo systemctl restart $SERVICE_NAME"
echo -e "  ${BOLD}Arrêter :${NC}      sudo systemctl stop $SERVICE_NAME"
echo ""
echo -e "  ${ORANGE}Conseil :${NC} utilise un reverse proxy (Caddy/nginx) pour HTTPS"
echo ""