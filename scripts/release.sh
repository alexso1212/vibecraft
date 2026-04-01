#!/bin/bash
# Vibecraft Release Script
# Usage: ./scripts/release.sh [patch|minor|major]
# Default: patch

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_DIR"

# Color output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

BUMP_TYPE="${1:-patch}"

# Validate bump type
if [[ ! "$BUMP_TYPE" =~ ^(patch|minor|major)$ ]]; then
  echo -e "${RED}Invalid bump type: $BUMP_TYPE${NC}"
  echo "Usage: $0 [patch|minor|major]"
  exit 1
fi

# Check npm login
if ! npm whoami &>/dev/null; then
  echo -e "${RED}Not logged in to npm. Run: npm login${NC}"
  exit 1
fi

# Check for uncommitted changes
if [ -n "$(git status --porcelain)" ]; then
  echo -e "${YELLOW}Warning: You have uncommitted changes.${NC}"
  git status --short
  echo ""
  read -p "Continue anyway? (y/N) " -n 1 -r
  echo
  if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    exit 1
  fi
fi

# Current version
OLD_VERSION=$(node -p "require('./package.json').version")
echo -e "Current version: ${YELLOW}v${OLD_VERSION}${NC}"

# Build first to catch errors early
echo -e "\n${GREEN}Building...${NC}"
npm run build

# Bump version (no git tag — we do it ourselves)
NEW_VERSION=$(npm version "$BUMP_TYPE" --no-git-tag-version)
echo -e "New version: ${GREEN}${NEW_VERSION}${NC}"

# Publish to npm (scoped package needs --access public)
echo -e "\n${GREEN}Publishing to npm...${NC}"
npm publish --access public

# Git commit + tag
git add package.json package-lock.json
git commit -m "release: ${NEW_VERSION}"
git tag "$NEW_VERSION"

# Push to fork (user's remote)
REMOTE="fork"
if ! git remote | grep -q "^fork$"; then
  REMOTE="origin"
fi

echo -e "\n${GREEN}Pushing to ${REMOTE}...${NC}"
git push "$REMOTE" --follow-tags

echo -e "\n${GREEN}Done! Published ${NEW_VERSION} to npm${NC}"
echo "  https://www.npmjs.com/package/vibecraft"
