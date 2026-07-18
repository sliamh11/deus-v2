#!/bin/bash
# Stages skill files for the container build image (LIA-426/F4 follow-up:
# bake SKILL.md instruction packs into the image).
#
# Two independent staging outputs land in the same per-skill directory under
# STAGING_DIR, each consumed by a different container/Dockerfile step:
#   - agent.ts: copied into /app/src/skills/ — the executable MCP-tool
#     mechanism (skill-mcp-registry.ts's loadSkillMcpTools()).
#   - SKILL.md / skill.md (+ any companion files a skill body may reference
#     via ${CLAUDE_SKILL_DIR}, e.g. references/, templates): copied into
#     /home/node/.claude/skills/ — the instruction-pack mechanism
#     (skill-context-loader.ts's discoverSkillRoots() personal root).
#
# Staging rules, most restrictive first:
#   1. Only git-tracked skill files are staged. An untracked (uncommitted)
#      skill dir under SOURCE_DIR is assumed to be a personal, local-only
#      addition (see feedback_local_only_skills.md: personal-account-
#      connecting skills must never leave local scope) and is never baked
#      into the shared container image, regardless of LOCAL_SKILLS_FILE.
#   2. A tracked skill listed by name in LOCAL_SKILLS_FILE (one name per
#      line, gitignored — see commit 30c839ac) is still excluded, for a
#      skill that IS committed to the repo but a given user doesn't want
#      shipped in their own local image build.
#
# Usage: stage-skills.sh <source_dir> <staging_dir> [local_skills_file]
# Must be invoked with cwd = the git repo root whose tracked-file state
# governs rule 1 (container/build.sh does this; the regression test uses a
# throwaway fixture repo for the same reason).

set -e

SOURCE_DIR="${1:?usage: stage-skills.sh <source_dir> <staging_dir> [local_skills_file]}"
STAGING_DIR="${2:?usage: stage-skills.sh <source_dir> <staging_dir> [local_skills_file]}"
LOCAL_SKILLS_FILE="${3:-.local-skills}"

rm -rf "$STAGING_DIR"
mkdir -p "$STAGING_DIR"

if [ ! -d "$SOURCE_DIR" ]; then
  exit 0
fi

LOCAL_ONLY_SKILLS=""
if [ -f "$LOCAL_SKILLS_FILE" ]; then
  LOCAL_ONLY_SKILLS=$(grep -v '^#' "$LOCAL_SKILLS_FILE" 2>/dev/null | grep -v '^$' || true)
fi

for skill_dir in "$SOURCE_DIR"/*/; do
  [ -d "$skill_dir" ] || continue
  skill_name=$(basename "$skill_dir")

  if echo "$LOCAL_ONLY_SKILLS" | grep -qx "$skill_name" 2>/dev/null; then
    echo "  Skipped local-only skill: $skill_name"
    continue
  fi

  tracked_files=$(git ls-files -- "$skill_dir" 2>/dev/null || true)
  if [ -z "$tracked_files" ]; then
    echo "  Skipped untracked skill dir: $skill_name"
    continue
  fi

  if [ -f "${skill_dir}agent.ts" ] || [ -f "${skill_dir}SKILL.md" ] || [ -f "${skill_dir}skill.md" ]; then
    mkdir -p "$STAGING_DIR/$skill_name"
    while IFS= read -r f; do
      [ -n "$f" ] || continue
      rel="${f#"$skill_dir"}"
      dest="$STAGING_DIR/$skill_name/$rel"
      mkdir -p "$(dirname "$dest")"
      cp "$f" "$dest"
    done <<< "$tracked_files"
    echo "  Staged skill: $skill_name"
  fi
done
