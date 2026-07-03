# Text Embeddings Inference (TEI) — Local Embedding Provider

HuggingFace [Text Embeddings Inference](https://github.com/huggingface/text-embeddings-inference) (TEI) is a self-hosted, OpenAI-compatible embedding server. OmniRoute ships built-in support for TEI as a local embedding provider — no API key required.

## Quick start

### 1. Run TEI locally

Using Docker (recommended):

```bash
docker run --gpus all -p 8080:80 -v /data:/data \
  ghcr.io/huggingface/text-embeddings-inference:latest \
  --model-id BAAI/bge-m3
```

Without GPU (CPU-only):

```bash
docker run -p 8080:80 -v /data:/data \
  ghcr.io/huggingface/text-embeddings-inference:cpu-latest \
  --model-id BAAI/bge-m3
```

Verify TEI is running:

```bash
curl http://localhost:8080/v1/embeddings \
  -H "Content-Type: application/json" \
  -d '{"model":"BAAI/bge-m3","input":"hello"}'
```

### 2. Call via OmniRoute

OmniRoute routes `tei/<model-id>` to the local TEI server automatically:

```bash
curl http://localhost:20128/v1/embeddings \
  -H "Content-Type: application/json" \
  -d '{
    "model": "tei/BAAI/bge-m3",
    "input": "hello world"
  }'
```

No API key, no provider connection setup needed — TEI is hardcoded in the embedding registry with `authType: "none"`.

## How it works

| Layer                        | File                                      | Role                                                                              |
| ---------------------------- | ----------------------------------------- | --------------------------------------------------------------------------------- |
| Provider catalog (UI)        | `src/shared/constants/providers/local.ts` | TEI appears in dashboard under "Local" providers                                  |
| Embedding registry (routing) | `open-sse/config/embeddingRegistry.ts`    | `/v1/embeddings` resolves `tei/*` models to `http://localhost:8080/v1/embeddings` |
| Embedding handler            | `open-sse/handlers/embeddings.ts`         | Forwards request to TEI, skips auth (authType: "none")                            |
| Embedding service            | `src/lib/embeddings/service.ts`           | Looks up provider config, calls `handleEmbedding`                                 |

### Request flow

```
Client → POST /v1/embeddings { model: "tei/BAAI/bge-m3" }
  → src/app/api/v1/embeddings/route.ts
    → src/lib/embeddings/service.ts::createEmbeddingResponse()
      → parseEmbeddingModel("tei/BAAI/bge-m3") → { provider: "tei", model: "BAAI/bge-m3" }
      → getEmbeddingProvider("tei") → EMBEDDING_PROVIDERS.tei
      → authType === "none" → skip credential lookup
      → handleEmbedding() → fetch http://localhost:8080/v1/embeddings
    → JSON response back to client
```

## Pre-registered models

These models are pre-listed in the registry for UI display. TEI serves any model it has loaded — `passthroughModels: true` means OmniRoute forwards unknown model IDs too.

| Model ID                                  | Dimensions |
| ----------------------------------------- | ---------- |
| `BAAI/bge-large-en-v1.5`                  | 1024       |
| `BAAI/bge-base-en-v1.5`                   | 768        |
| `BAAI/bge-m3`                             | 1024       |
| `intfloat/e5-large-v2`                    | 1024       |
| `intfloat/multilingual-e5-large-instruct` | 1024       |
| `Qwen/Qwen3-Embedding-8B`                 | 4096       |
| `Qwen/Qwen3-Embedding-4B`                 | 2560       |
| `Qwen/Qwen3-Embedding-0.6B`               | 1024       |
| `nomic-ai/nomic-embed-text-v1.5`          | 768        |
| `sentence-transformers/all-MiniLM-L6-v2`  | 384        |

## Custom port / remote TEI

If TEI runs on a different port or host, create a `provider_node` to override the base URL:

### Via dashboard

1. Go to **Dashboard → Providers → Local → TEI**
2. Add a connection with custom base URL (e.g. `http://192.168.1.100:8080/v1`)

### Via API

```bash
curl -X POST http://localhost:20128/api/provider-nodes \
  -H "Content-Type: application/json" \
  -d '{
    "id": "tei-remote",
    "type": "openai-compatible",
    "name": "TEI Remote",
    "prefix": "tei",
    "apiType": "embeddings",
    "baseUrl": "http://192.168.1.100:8080/v1"
  }'
```

The embedding service (`src/lib/embeddings/service.ts`) detects localhost/LAN hostnames in `provider_nodes` and builds a dynamic `EmbeddingProvider` that takes precedence over the hardcoded registry entry.

## Rerank support

TEI also exposes `/v1/rerank` for reranking. OmniRoute's rerank handler (`open-sse/handlers/rerank.ts`) follows the same provider-node pattern — add a `provider_node` with `apiType: "rerank"` to enable it.

## Troubleshooting

| Symptom                               | Cause                   | Fix                                               |
| ------------------------------------- | ----------------------- | ------------------------------------------------- |
| `Unknown embedding provider: tei`     | Registry not loaded     | Restart OmniRoute after updating                  |
| `connect ECONNREFUSED 127.0.0.1:8080` | TEI not running         | `docker ps` — start TEI container                 |
| `401 No valid authentication token`   | authType mismatch       | Ensure registry entry has `authType: "none"`      |
| Wrong dimensions in response          | Model not loaded in TEI | Check `--model-id` flag matches the request model |
