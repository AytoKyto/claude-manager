#!/usr/bin/env bash
# Claude Manager — lance le dashboard
cd "$(dirname "$0")"
echo ""
echo "  ⌘ Claude Manager"
echo "  ──────────────────────────────"
echo "  http://localhost:3131"
echo ""
node server.js
