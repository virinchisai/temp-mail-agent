// The agent loop. This is the piece that makes the project an "agent"
// rather than a REST service: instead of the caller choosing which
// endpoint to hit, the model reads the request and decides which tools to
// call, in what order, and when it has finished.
const Anthropic = require('@anthropic-ai/sdk');
const { buildTools } = require('./tools');

const MODEL = process.env.AGENT_MODEL || 'claude-opus-5';
// One "iteration" is one model turn; a watch-for-a-code task legitimately
// needs many (check, wait, check again), so this is generous but bounded
// to keep a confused run from looping forever.
const MAX_ITERATIONS = Number(process.env.AGENT_MAX_ITERATIONS) || 30;

const SYSTEM_PROMPT = `You are the assistant for a disposable email service. You help the user create temporary inboxes, read what arrives in them, pull out verification codes, extend expiry, and clean up — by calling the tools available to you.

How the service works:
- Inboxes are real and receive real mail, but they expire. Default lifetime is 15 minutes; extend_inbox pushes that back.
- get_otp returns {"otp": null} until a code actually arrives. That is the normal empty state, not a failure.
- To watch for a code: call get_otp, then wait, then get_otp again. Keep the waits short (10-15s) and tell the user what you are doing if it takes several rounds. If nothing has arrived after roughly two minutes, stop and say so rather than looping in silence — mention that some services block known disposable-mail domains, which is a common reason a code never arrives.
- Temporary phone numbers may be backed by a mock provider that returns a fake canned code. If a number's provider is "mock", say plainly that it is not a real number.

How to respond:
- Always give the user the full email address when you create an inbox. It is the thing they actually need.
- Keep replies short and factual. The user can see which tools you called, so do not narrate your steps back to them or restate results in a bulleted summary.
- Report outcomes faithfully. If a tool returned an error, say what failed rather than papering over it.
- Deliver what was asked at the scope it was asked. Do not delete or extend anything the user did not ask you to touch — deletion is irreversible.`;

class MissingApiKeyError extends Error {}

// Two ways to be configured: a real Anthropic key, or a base URL pointing
// at a local model proxy (see litellm.config.yaml) which needs no key.
function isConfigured() {
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_BASE_URL);
}

// True when running against a local proxy rather than Anthropic's API —
// the dashboard surfaces this so it's obvious which model is answering.
function isLocal() {
  return Boolean(process.env.ANTHROPIC_BASE_URL);
}

/**
 * Runs one turn of the conversation to completion.
 *
 * @param {object}   opts
 * @param {string}   opts.apiKey    the account's tma_ key — the agent acts as this account
 * @param {string}   opts.baseUrl   where this service's own REST API is reachable
 * @param {Array}    opts.messages  full conversation history (the API is stateless)
 * @returns {Promise<{reply: string, steps: Array, messages: Array}>}
 */
async function runAgent({ apiKey, baseUrl, messages }) {
  if (!isConfigured()) {
    throw new MissingApiKeyError(
      'The assistant is not configured. Set ANTHROPIC_API_KEY, or point ' +
        'ANTHROPIC_BASE_URL at a local model proxy. See .env.example.'
    );
  }

  // A local proxy (LiteLLM in front of Ollama) needs no real credential,
  // but the SDK insists on some value — so supply a placeholder rather
  // than making the user invent a fake key.
  const client = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY || 'local-proxy-no-key-required',
  });
  const steps = [];

  const tools = buildTools({
    apiKey,
    baseUrl,
    onCall: ({ name, input, result }) => steps.push({ type: 'tool', name, input, result }),
  });

  const runner = client.beta.messages.toolRunner({
    model: MODEL,
    max_tokens: 16000,
    // These are short, well-defined API calls rather than hard reasoning,
    // so medium keeps latency and cost down without hurting quality.
    output_config: { effort: 'medium' },
    system: SYSTEM_PROMPT,
    tools,
    messages,
    max_iterations: MAX_ITERATIONS,
  });

  // Iterating (rather than just awaiting) lets us interleave the assistant's
  // own text with the tool calls, so the UI can show the run in order.
  let lastMessage = null;
  for await (const message of runner) {
    lastMessage = message;
    for (const block of message.content) {
      if (block.type === 'text' && block.text.trim()) {
        steps.push({ type: 'text', text: block.text });
      }
    }
  }

  const reply =
    (lastMessage?.content || [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim() ||
    "I wasn't able to produce a reply for that.";

  // Persist only the assistant's text, not the raw content blocks: those
  // contain tool_use blocks whose matching tool_result blocks live inside
  // the runner's own history, and sending a tool_use without its result is
  // rejected by the API. If a later turn needs an id it dropped, it can
  // call list_inboxes — so this stays correct without special-casing.
  const updated = [...messages, { role: 'assistant', content: reply }];

  return { reply, steps, messages: updated, stopReason: lastMessage?.stop_reason || null };
}

module.exports = { runAgent, MissingApiKeyError, MODEL, isConfigured, isLocal };
