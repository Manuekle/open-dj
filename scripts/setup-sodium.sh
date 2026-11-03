#!/usr/bin/env bash
set -euo pipefail
if [ ! -f components.json ]; then npx shadcn@latest init -d; fi
npx shadcn@latest add https://design.how/r/sodium/theme.json --yes
npx skills add arla6ka/design.how
npx shadcn@latest add https://design.how/r/sodium/lint.json --yes
npx eslint -c sodium.eslint.config.mjs .
echo "Sodium theme and lint installed. Follow .claude/skills/sodium/SKILL.md for each future UI edit."
