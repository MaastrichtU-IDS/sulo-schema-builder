#!/bin/sh
# Build the QLever index from seed Turtle files, or restore from a backup.
#
# Environment variables:
#   RESTORE_FROM   — path to a backup TTL file (mounted into the container).
#                    If set, the index is always rebuilt from this file,
#                    regardless of whether an index already exists.
#   (unset)        — normal startup: skip if index exists, otherwise seed.
#
# Runs as the qlever-init init container.

set -e

INDEX_FILE="/data/sulo.index.pos"

# Base namespace — defaults to the canonical w3id.org IRI baked into the ontology file.
# Override via BASE_NAMESPACE env var; must end with '/'.
BASE_NS="${BASE_NAMESPACE:-https://w3id.org/sulo/schema/}"
DEFAULT_NS="https://w3id.org/sulo/schema/"

# ── Restore mode ──────────────────────────────────────────────────────────────
if [ -n "${RESTORE_FROM:-}" ]; then
    if [ ! -f "${RESTORE_FROM}" ]; then
        echo "ERROR: RESTORE_FROM is set but file not found: ${RESTORE_FROM}" >&2
        exit 1
    fi
    echo "Restore mode: rebuilding index from ${RESTORE_FROM}"
    cd /data
    rm -f ./*.ttl sulo.index.* sulo.vocabulary.* sulo.meta-* sulo.prefixes 2>/dev/null || true

    echo "Preparing backup (reordering prefixes)..."
    {
      grep '^@prefix' "${RESTORE_FROM}" | sort -u
      echo ""
      grep -v '^@prefix' "${RESTORE_FROM}" | grep -v '^#' | grep -v '^[[:space:]]*$'
    } > merged.ttl

    echo "Building QLever index from backup..."
    echo '{}' > settings.json
    cat merged.ttl | /qlever/qlever-index -i sulo -s settings.json \
        --vocabulary-type on-disk-compressed -F ttl -f - -p false

    echo "Restore complete."
    exit 0
fi

# ── Normal startup ────────────────────────────────────────────────────────────
if [ -f "$INDEX_FILE" ]; then
    echo "QLever index already exists — skipping rebuild."
    exit 0
fi

echo "Copying seed data into working directory..."
cd /data
rm -f ./*.ttl
cp /sparql-data/ontology/*.ttl .
cp /sparql-data/seed/schemas/*.ttl . 2>/dev/null || true
cp /sparql-data/seed/*.ttl . 2>/dev/null || true

# Substitute custom BASE_NAMESPACE into the ontology (and any seed files) if it differs
if [ "${BASE_NS}" != "${DEFAULT_NS}" ]; then
    echo "Substituting base namespace: ${DEFAULT_NS} → ${BASE_NS}"
    for f in ./*.ttl; do
        sed -i "s|${DEFAULT_NS}|${BASE_NS}|g" "$f"
    done
fi

echo "Merging TTL files (prefixes first)..."
# QLever requires all @prefix declarations before any triples in the stream.
{
  grep -h '^@prefix' ./*.ttl | sort -u
  echo ""
  grep -hv '^@prefix' ./*.ttl | grep -v '^#' | grep -v '^[[:space:]]*$'
} > merged.ttl

echo "Building QLever index..."
echo '{}' > settings.json
cat merged.ttl | /qlever/qlever-index -i sulo -s settings.json \
    --vocabulary-type on-disk-compressed -F ttl -f - -p false

echo "Index build complete."
