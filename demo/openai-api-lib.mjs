export const OPENAI_API_CHAT_COMPLETIONS = "chat-completions";
export const OPENAI_API_RESPONSES = "responses";
export const OPENAI_API_VALUES = Object.freeze([
  OPENAI_API_RESPONSES,
  OPENAI_API_CHAT_COMPLETIONS,
]);

export function normalizeOpenAIApi(value, fallback = OPENAI_API_RESPONSES) {
  const normalized = String(value ?? fallback).trim().toLowerCase();
  if (normalized === "responses" || normalized === "response") return OPENAI_API_RESPONSES;
  if (
    normalized === "chat-completions" ||
    normalized === "chat_completions" ||
    normalized === "chat" ||
    normalized === "completions"
  ) {
    return OPENAI_API_CHAT_COMPLETIONS;
  }
  throw new Error(
    `--openai-api must be one of: ${OPENAI_API_VALUES.join(", ")}`,
  );
}

export function openAIPath(api) {
  return normalizeOpenAIApi(api) === OPENAI_API_RESPONSES
    ? "/v1/responses"
    : "/v1/chat/completions";
}

export function buildOpenAIRequestBody({
  api,
  model,
  prompt,
  maxOutputTokens,
  stream = true,
}) {
  if (normalizeOpenAIApi(api) === OPENAI_API_RESPONSES) {
    return {
      model,
      input: prompt,
      stream,
      max_output_tokens: maxOutputTokens,
      reasoning: { effort: "none" },
    };
  }

  return {
    model,
    messages: [{ role: "user", content: prompt }],
    stream,
    ...(stream ? { stream_options: { include_usage: true } } : {}),
    max_completion_tokens: maxOutputTokens,
    reasoning_effort: "none",
  };
}

function usageFromResponsesEvent(parsed) {
  const usage = parsed?.response?.usage ?? parsed?.usage;
  if (!usage || typeof usage !== "object") return null;
  const input = Number(usage.input_tokens);
  const output = Number(usage.output_tokens);
  if (!Number.isFinite(input) || !Number.isFinite(output)) return null;
  return { input, output };
}

export function observeOpenAIStreamEvent(parsed, api) {
  if (normalizeOpenAIApi(api) === OPENAI_API_RESPONSES) {
    const delta = parsed?.type === "response.output_text.delta" && typeof parsed?.delta === "string"
      ? parsed.delta
      : "";
    return {
      text: delta,
      usage: usageFromResponsesEvent(parsed),
    };
  }

  const content = parsed?.choices?.[0]?.delta?.content;
  const promptTokens = Number(parsed?.usage?.prompt_tokens);
  const completionTokens = Number(parsed?.usage?.completion_tokens);
  return {
    text: typeof content === "string" ? content : "",
    usage:
      Number.isFinite(promptTokens) && Number.isFinite(completionTokens)
        ? { input: promptTokens, output: completionTokens }
        : null,
  };
}
