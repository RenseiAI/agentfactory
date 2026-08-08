# @donmai/code-intelligence

> **DEPRECATED.** This package is deprecated. The code-intelligence engine is now
> implemented natively in Go inside the `donmai` binary, and this TypeScript
> package has no live runtime consumer. It is preserved (not removed) for OSS
> continuity because downstream npm consumers may pin it, but it will receive no
> further feature work and will be removed in a future major. New work should
> target the native Go surface: the `donmai code` subcommands (`get-repo-map`,
> `search-symbols`, `search-code`, `check-duplicate`, `find-type-usages`,
> `validate-cross-deps`) or the `donmai mcp code-intel` MCP server (server name
> `af-code-intelligence`), which expose the same `af_code_*` tools.

Code intelligence for Donmai agents — regex-based symbol extraction, BM25 search, incremental Merkle-tree indexing, PageRank repo maps, and memory deduplication.

Part of the [Donmai](https://github.com/RenseiAI/donmai-libraries) monorepo.

## Installation

```bash
npm install @donmai/code-intelligence
```

## Features

| Module | What it does |
|--------|-------------|
| **Parser** | Extracts symbols (functions, classes, types, interfaces) from TypeScript, Python, Go, and Rust using regex-based extractors |
| **Search** | BM25-ranked code search with code-aware tokenization (camelCase splitting, stop-word removal) and exact/fuzzy match boosting |
| **Indexing** | Merkle-tree change detection with git-compatible hashing — only re-indexes files that changed |
| **Repo Map** | Builds a dependency graph from imports, ranks files by PageRank, and outputs an LLM-friendly repository map |
| **Memory** | Two-tier deduplication: xxHash64 for exact matches, SimHash for near-duplicates with configurable Hamming distance |

## Usage

### Symbol extraction

```typescript
import { SymbolExtractor } from '@donmai/code-intelligence'

const extractor = new SymbolExtractor()
const ast = extractor.extractFromSource(sourceCode, 'src/index.ts')

for (const symbol of ast.symbols) {
  console.log(`${symbol.kind}: ${symbol.name} (line ${symbol.line})`)
}
```

### Code search

```typescript
import { SearchEngine, SymbolExtractor } from '@donmai/code-intelligence'

const extractor = new SymbolExtractor()
const engine = new SearchEngine()

// Extract symbols from your files, then build the index
const symbols = files.flatMap(f => extractor.extractFromSource(f.content, f.path).symbols)
engine.buildIndex(symbols)

const results = engine.search({ query: 'handleRequest', maxResults: 10 })
```

### Incremental indexing

```typescript
import { IncrementalIndexer, SymbolExtractor } from '@donmai/code-intelligence'

const indexer = new IncrementalIndexer(new SymbolExtractor())

// Load previous index (if any)
await indexer.load(process.cwd())

// Index files — only changed files are re-processed
const files = new Map([['src/app.ts', sourceCode]])
const { changes, indexed, metadata } = await indexer.index(files)

console.log(`${changes.added.length} added, ${changes.modified.length} modified`)

// Persist for next run
await indexer.save(process.cwd())
```

### Repository map

```typescript
import { SymbolExtractor, RepoMapGenerator } from '@donmai/code-intelligence'

const extractor = new SymbolExtractor()
const generator = new RepoMapGenerator()

const asts = files.map(f => extractor.extractFromSource(f.content, f.path))
const entries = generator.generate(asts, { maxFiles: 30 })

console.log(generator.format(entries))
```

### Memory deduplication

```typescript
import { DedupPipeline, InMemoryStore } from '@donmai/code-intelligence'

const pipeline = new DedupPipeline(new InMemoryStore())

// Store content
await pipeline.storeContent('entry-1', 'some code block...')

// Check for duplicates
const result = await pipeline.check('some code block...')
// → { isDuplicate: true, matchType: 'exact', existingId: 'entry-1' }
```

## Agent tool plugin

When used with Donmai's Claude provider, the package registers four in-process MCP tools:

| Tool | Description |
|------|-------------|
| `af_code_search_symbols` | Search symbols by name with kind/language/file filtering |
| `af_code_get_repo_map` | PageRank-ranked repo map of the most important files |
| `af_code_search_code` | BM25 code search with code-aware tokenization |
| `af_code_check_duplicate` | xxHash64 exact + SimHash near-duplicate detection |

```typescript
import { codeIntelligencePlugin } from '@donmai/code-intelligence'

// Register with orchestrator
const orchestrator = createOrchestrator({
  toolPlugins: [codeIntelligencePlugin],
})
```

## Supported languages

- TypeScript / JavaScript
- Python
- Go
- Rust

## License

MIT
