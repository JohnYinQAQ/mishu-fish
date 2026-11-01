#!/usr/bin/env bash
# 打一个可以上传到 GitHub Releases 的压缩包（排除本地数据与依赖）
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION=$(node -p "require('./package.json').version" 2>/dev/null || grep -m1 '"version"' package.json | cut -d'"' -f4)
OUT_DIR="release"
NAME="mishu-fish-${VERSION}"
mkdir -p "$OUT_DIR"
rm -f "$OUT_DIR/${NAME}.zip"

zip -r "$OUT_DIR/${NAME}.zip" \
  README.md CHANGELOG.md LICENSE package.json pnpm-lock.yaml \
  tsconfig.json tsconfig.build.json cordis.patch.yml \
  lib dist src bin scripts docs \
  -x "*.DS_Store" > /dev/null

echo "已生成 $OUT_DIR/${NAME}.zip"
ls -lh "$OUT_DIR/${NAME}.zip" | awk '{print $5, $9}'
