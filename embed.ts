// embed.ts — local 384-dim embeddings (bge-small) via transformers.js. Offline after the first
// model download (cached). SWAP POINT (like llm.ts): replace the body for a different/cloud embedder.
import { pipeline, env } from "@xenova/transformers";

// prefer WASM (no native binary needed); allow remote model download once, then it's cached.
(env as any).allowLocalModels = false;

let extractor: any = null;
async function getExtractor() {
  if (!extractor) extractor = await pipeline("feature-extraction", "Xenova/bge-small-en-v1.5");
  return extractor;
}

// returns a 384-dim, mean-pooled, L2-normalized vector
export async function embed(text: string): Promise<number[]> {
  const ex = await getExtractor();
  const out = await ex((text ?? "").slice(0, 4000), { pooling: "mean", normalize: true });
  return Array.from(out.data as Float32Array);
}

// pgvector literal form: "[0.1,0.2,...]"
export const toVector = (v: number[]): string => `[${v.join(",")}]`;
