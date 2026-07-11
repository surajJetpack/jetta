/**
 * Resolves the AI SDK language model for the configured provider.
 *
 * Switching the LLM is a one-line change: set LLM_PROVIDER (or swap the model
 * id in config.llm.models). Gemini is used for development now; Claude
 * (claude-sonnet-4-6) is the production target per the product spec.
 */
import type { LanguageModel } from "ai";
import { google } from "@ai-sdk/google";
import { anthropic } from "@ai-sdk/anthropic";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { config } from "./config";

export function getModel(): LanguageModel {
  const { provider, models } = config.llm;
  const modelId = models[provider];

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

/** Human-readable label for logs/responses, e.g. "google/gemini-2.5-pro". */
export function modelLabel(): string {
  return `${config.llm.provider}/${config.llm.models[config.llm.provider]}`;
}
