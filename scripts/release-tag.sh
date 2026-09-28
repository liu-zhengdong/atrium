#!/usr/bin/env bash
# main 的 push 在当前工作流里打 tag；GITHUB_TOKEN 推送的 tag 不会再触发工作流。
set -euo pipefail

for attempt in {1..10}; do
  git fetch --quiet --force --tags origin
  tags=$(git tag --list 'v*' | grep -E '^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$' |
    python3 -c 'import sys; print("".join(sorted(sys.stdin, key=lambda s: tuple(map(int, s[1:].split("."))), reverse=True)), end="")' || true)
  while IFS= read -r tag; do
    if [ -n "$tag" ] && git merge-base --is-ancestor "$GITHUB_SHA" "$tag^{commit}"; then
      echo "version=$tag" >> "$GITHUB_OUTPUT"
      if [ "$(git rev-list -n 1 "$tag")" != "$GITHUB_SHA" ]; then
        echo 'covered_by_newer=true' >> "$GITHUB_OUTPUT"
      fi
      exit 0
    fi
  done <<< "$tags"

  latest=$(printf '%s\n' "$tags" | head -1)
  if [ -n "$latest" ]; then
    prefix=${latest%.*}
    patch=${latest##*.}
    version="$prefix.$((patch + 1))"
  else
    version=v0.1.0
  fi
  git tag "$version" "$GITHUB_SHA"
  if git push origin "refs/tags/$version"; then
    echo "version=$version" >> "$GITHUB_OUTPUT"
    exit 0
  fi
  git tag -d "$version" >/dev/null
  echo "tag $version 推送冲突，第 $attempt 次重算" >&2
done

echo 'tag 推送重试 10 次仍失败' >&2
exit 1
