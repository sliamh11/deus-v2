#!/bin/bash
# Build the Deus agent container image

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

IMAGE_NAME="deus-agent"
TAG="${1:-latest}"
CONTAINER_RUNTIME="${CONTAINER_RUNTIME:-docker}"

echo "Building Deus agent container image..."
echo "Image: ${IMAGE_NAME}:${TAG}"

# Stage skill files for the container build: agent.ts (executable MCP-tool
# skills) and SKILL.md instruction packs (LIA-426/F4 follow-up — baked into
# /home/node/.claude/skills/ by the Dockerfile so skills are discoverable in
# the default no-project chat case, not just when a project mounts its own
# .claude/skills/). This staging step runs on every build so the container
# always has current skills. See container/stage-skills.sh for the full
# staging contract (git-tracked-only, .local-skills exclusion).
STAGING_DIR="container/skill-agents"
"$SCRIPT_DIR/stage-skills.sh" ".claude/skills" "$STAGING_DIR"

# Build from project root so Dockerfile can access staged files
${CONTAINER_RUNTIME} build -t "${IMAGE_NAME}:${TAG}" -f container/Dockerfile .

# Clean up staging directory
rm -rf "$STAGING_DIR"

echo ""
echo "Build complete!"
echo "Image: ${IMAGE_NAME}:${TAG}"
echo ""
echo "Test with:"
echo "  echo '{\"prompt\":\"What is 2+2?\",\"groupFolder\":\"test\",\"chatJid\":\"test@g.us\",\"isMain\":false}' | ${CONTAINER_RUNTIME} run -i ${IMAGE_NAME}:${TAG}"
