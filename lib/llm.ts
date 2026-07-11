/**
 * Resolves the AI SDK language model for the configured provider and tier.
 *
 * Switching the LLM is a one-line change: set LLM_PROVIDER (or swap the model
 * ids in config.llm.models). Tiers: "standard" (default) for quality-critical
 * customer-facing runs, "light" for cheap/fast calls (classification, rerank).
 */
import type { LanguageModel } from "ai";
import { google } from "@ai-sdk/google";
import { anthropic } from "@ai-sdk/anthropic";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { config, type ModelTier } from "./config";

export type { ModelTier };

export function getModel(tier: ModelTier = "standard"): LanguageModel {
  const { provider } = config.llm;
  const modelId = config.llm.models[tier][provider];

  switch (provider) {
    case "google":
      if (!config.google.apiKey) throw new Error("GOOGLE_GENERATIVE_AI_API_KEY is not set.");
      return google(modelId);
    case "anthropic":
      if (!config.anthropic.apiKey) throw new Error("ANTHROPIC_API_KEY is not set.");
      return anthropic(modelId);
    case "openrouter":
      if (!config.openrouter.apiKey) throw new Error("OPENROUTER_API_KEY is not set.");
      return createOpenRouter({ apiKey: config.openrouter.apiKey }).chat(modelId);
    default:
      throw new Error(`Unknown LLM provider: ${provider}`);
  }
}

/** True when the active provider's API key is present. */
export function llmKeyPresent(): boolean {
  switch (config.llm.provider) {
    case "google":
      return !!config.google.apiKey;
    case "anthropic":
      return !!config.anthropic.apiKey;
    case "openrouter":
      return !!config.openrouter.apiKey;
    default:
      return false;
  }
}

/** Human-readable label for logs/responses, e.g. "openrouter/anthropic/claude-sonnet-5". */
export function modelLabel(tier: ModelTier = "standard"): string {
  return `${config.llm.provider}/${config.llm.models[tier][config.llm.provider]}`;
}
