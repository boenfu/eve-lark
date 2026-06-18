import { defineAgent } from "eve";
import { createOpenAI } from "@ai-sdk/openai";

// Two ways to configure the model:
//
// 1. OpenAI-compatible endpoint (DeepSeek, Kimi, 智谱, Ollama, vLLM, …):
//    set OPENAI_BASE_URL + OPENAI_API_KEY + MODEL=<model-id>
//    e.g. for DeepSeek: OPENAI_BASE_URL=https://api.deepseek.com/v1
//                       OPENAI_API_KEY=sk-xxx
//                       MODEL=deepseek-chat
//
// 2. AI-Gateway-routed string (default): just set MODEL=anthropic/claude-sonnet-4.6
//    or openai/gpt-4o etc., and provide the matching API key as ANTHROPIC_API_KEY
//    or OPENAI_API_KEY (routed via the Vercel AI Gateway).
function resolveModel() {
  if (process.env.OPENAI_BASE_URL) {
    const provider = createOpenAI({
      apiKey: process.env.OPENAI_API_KEY ?? "",
      baseURL: process.env.OPENAI_BASE_URL,
      // Some compatible endpoints (DeepSeek, 智谱) reject the OpenAI-specific
      // `X-OpenAI-Client-Version` header; setting name to "" omits it.
      name: "",
    });
    // `.chat()` → classic `/chat/completions`. The bare `provider(id)` call
    // in v2-beta-16 routes to OpenAI's newer `/responses` endpoint, which
    // most OpenAI-compatible providers (DeepSeek, Kimi, 智谱, Ollama, …) do
    // NOT implement. Use `.chat()` for compatibility with them.
    return provider.chat(process.env.MODEL ?? "gpt-4o");
  }
  // Fall back to a bare model string — resolved via the AI SDK global default
  // provider (Vercel AI Gateway).
  return process.env.MODEL ?? "anthropic/claude-sonnet-4.6";
}

export default defineAgent({
  model: resolveModel() as never,
  // When using an external provider, eve can't look up context-window metadata
  // from the AI Gateway. Set a sane default so compaction has a limit. Override
  // via MODEL_CONTEXT_WINDOW_TOKENS if you need a different value.
  modelContextWindowTokens: process.env.MODEL_CONTEXT_WINDOW_TOKENS
    ? Number(process.env.MODEL_CONTEXT_WINDOW_TOKENS)
    : 128_000,
});
