#!/bin/sh
set -e

mkdir -p "${MCP_DATA_DIR:-/data}" "${MCP_SITES_DIR:-/sites}"
chown -R mcp:mcp "${MCP_DATA_DIR:-/data}" "${MCP_SITES_DIR:-/sites}"

exec su-exec mcp "$@"
