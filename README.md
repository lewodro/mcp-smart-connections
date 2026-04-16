# Smart Connections MCP Server (fork)

> **Forked from [gogogadgetbytes/smart-connections-mcp](https://github.com/gogogadgetbytes/smart-connections-mcp)** with additions for self-indexing and automatic index refresh.

Exposes [Smart Connections](https://github.com/brianpetro/obsidian-smart-connections) embeddings to Claude Code and other [MCP](https://modelcontextprotocol.io/) clients for semantic search of your Obsidian vault.

## Changes from upstream

| Change | Description |
|--------|-------------|
| **Block-level search** | Loads `smart_blocks:` entries alongside `smart_sources:` so search matches against individual sections, not just whole files. Results show which heading matched. |
| **Block-level indexing** | `reindex` splits files by markdown headings and embeds each block separately — same approach as Obsidian's Smart Connections plugin. Handles frontmatter and fenced code blocks. |
| **Staleness detection** | `reindex` compares `.md` file mtime against `.ajson` file mtime. Modified files are automatically re-embedded — no manual cache clearing needed. |
| **`reindex` tool** | Scans the vault for new or modified `.md` files and computes embeddings without Obsidian. Uses progressive truncation (1500→1000→600 chars) for the model's 512-token window. |
| **Auto-refresh index** | `refreshIfNeeded()` checks `.smart-env/multi/` directory mtime on each tool call and reloads embeddings when they change on disk. No more MCP reconnects after Obsidian re-indexes. |
| **Search deduplication** | Multiple blocks from the same file won't flood results — returns only the best-matching block per note. |

## Features

- **Block-level search** - matches individual sections within notes, not just whole files
- **Self-indexing** - compute and write embeddings without Obsidian open
- **Staleness detection** - modified files are re-embedded automatically on reindex
- **Auto-refresh** - picks up new embeddings from Obsidian without reconnecting
- **Text search** - query with plain text, not just note paths
- **Semantic search** using Smart Connections embeddings
- **Local inference** - uses Transformers.js (same model as Smart Connections)
- **Secure** - strict path validation, bounded responses
- **Offline** - works without Obsidian running

## Security Model

| Property | Guarantee |
|----------|-----------|
| Path confinement | All file access validated against vault root |
| No traversal | `../` and symlink attacks blocked |
| Write-confined | Writes only to `.smart-env/multi/` (embedding data, never your notes) |
| Bounded responses | Capped results (50), content length (10KB) |
| Fail closed | Errors deny access, never bypass |
| Audit logging | Security events logged with context |

## Installation

### Prerequisites

- Node.js 18+
- An Obsidian vault (Smart Connections plugin optional — `reindex` can bootstrap without it)

### 1. Clone and build

```bash
git clone <repo-url>
cd smart-connections-mcp
npm install
npx tsc
```

### 2. Add MCP server to your project

Create or edit `.mcp.json` in your vault/project root:

```json
{
  "mcpServers": {
    "smart-connections": {
      "command": "node",
      "args": ["/path/to/smart-connections-mcp/dist/index.js"],
      "env": {
        "VAULT_PATH": "/path/to/your/obsidian/vault"
      }
    }
  }
}
```

### 3. Allow read access (optional)

Add to `.claude/settings.local.json` so Claude can read the MCP server source without prompting:

```json
{
  "permissions": {
    "allow": [
      "Read(/path/to/smart-connections-mcp/**)"
    ]
  }
}
```

### 4. Bootstrap the index

If you have Smart Connections in Obsidian, open the vault — it will create `.smart-env/` with embeddings automatically.

If you don't have Smart Connections, create the minimal config:

```bash
mkdir -p .smart-env/multi
cat > .smart-env/smart_env.json << 'EOF'
{
  "smart_sources": {
    "embed_model": {
      "adapter": "transformers",
      "transformers": {
        "model_key": "TaylorAI/bge-micro-v2"
      }
    }
  }
}
EOF
```

Then connect the MCP in Claude Code (`/mcp`) and call the `reindex` tool to index all `.md` files.

### 5. Restart Claude Code

Run `/mcp` to connect the server, or restart Claude Code to pick it up automatically.

## Usage

Once configured, Claude Code can use these tools:

### Search by Text

```
"Search my vault for notes about backup strategies"
→ Uses search_by_text tool
```

### Search Similar Notes

```
"Find notes similar to Topics/Claude_Code.md"
→ Uses search_similar tool
```

### Get Note Content

```
"Show me the content of Topics/Obsidian.md"
→ Uses get_note tool
```

### List Indexed Notes

```
"What notes are indexed in my vault?"
→ Uses list_indexed tool
```

## Tools

| Tool | Description |
|------|-------------|
| `search_by_text` | Search using freeform text (computes embedding locally) |
| `search_similar` | Find notes semantically similar to a given note |
| `search_by_embedding` | Search using a raw embedding vector |
| `get_note` | Get content of a specific note (path validated) |
| `get_model_info` | Get embedding model configuration |
| `list_indexed` | List indexed notes (sources only by default, `includeBlocks` for all) |
| `reindex` | Index new/modified `.md` files with block-level embeddings |

## Configuration

| Variable | Required | Description |
|----------|----------|-------------|
| `VAULT_PATH` | Yes | Absolute path to Obsidian vault |

## Limitations

- **Single vault** - Configure one vault per MCP server instance
- **Obsidian optional** - `reindex` can bootstrap embeddings without Obsidian
- **First run needs internet** - downloads the `TaylorAI/bge-micro-v2` embedding model (~50MB) on first launch, then runs fully offline from `~/.cache/huggingface/`

## Development

```bash
# Build
npm run build

# Test with MCP Inspector
npx @modelcontextprotocol/inspector node dist/index.js
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Security-focused PRs welcome.

## Security

To report security vulnerabilities, please email gogogadgetcode@proton.me. Do not open public issues for security concerns.

## License

MIT - see [LICENSE](LICENSE)

## Credits

- [Smart Connections](https://github.com/brianpetro/obsidian-smart-connections) by Brian Petro
- [Model Context Protocol](https://modelcontextprotocol.io/) by Anthropic
