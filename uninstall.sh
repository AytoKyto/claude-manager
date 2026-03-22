#!/usr/bin/env bash
set -e

SERVICE_NAME="claude-manager"
INSTALL_DIR="$HOME/claude-manager"

RED='\033[0;31m'
GREEN='\033[0;32m'
ORANGE='\033[0;33m'
BOLD='\033[1m'
NC='\033[0m'

echo ""
echo -e "${RED}${BOLD}  ⌘ Claude Manager — Désinstallation${NC}"
echo -e "  ──────────────────────────────────"
echo ""

# Arrêter et supprimer le service systemd
if [[ "$(uname)" == "Linux" ]] && command -v systemctl &>/dev/null; then
  if systemctl list-unit-files | grep -q "$SERVICE_NAME"; then
    echo -e "${ORANGE}▸${NC} Arrêt du service..."
    sudo systemctl stop "$SERVICE_NAME" 2>/dev/null || true
    sudo systemctl disable "$SERVICE_NAME" 2>/dev/null || true
    sudo rm -f "/etc/systemd/system/${SERVICE_NAME}.service"
    sudo systemctl daemon-reload
    echo -e "${GREEN}✓${NC} Service supprimé"
  fi
fi

# Supprimer le dossier
if [ -d "$INSTALL_DIR" ]; then
  echo -e "${ORANGE}Supprimer $INSTALL_DIR ?${NC} [o/N] :"
  read -rp "  > " CONFIRM
  if [[ "$CONFIRM" =~ ^[OoYy]$ ]]; then
    rm -rf "$INSTALL_DIR"
    echo -e "${GREEN}✓${NC} Dossier supprimé"
  else
    echo -e "${ORANGE}▸${NC} Dossier conservé"
  fi
fi

echo ""
echo -e "${GREEN}✓ Désinstallation terminée${NC}"
echo ""