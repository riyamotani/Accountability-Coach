/**
 * Per-provider settings for a model call, keyed by the Gateway model id.
 *
 * Reasoning models (OpenAI's gpt-5 family) "think" in hidden tokens before
 * answering. Those tokens are billed as output and add latency, and for a
 * chat turn that only has to pick a tool and write two sentences, deep
 * reasoning is wasted money and seconds. `low` keeps the better tool choice
 * that made the switch worth it while bounding both.
 *
 * Options for one provider are ignored by every other, so this is safe to
 * pass whichever model is configured.
 */
export function providerOptionsFor(modelId: string) {
  if (modelId.startsWith('openai/gpt-5')) {
    return { openai: { reasoningEffort: 'low' } };
  }
  return undefined;
}
