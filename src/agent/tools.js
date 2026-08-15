// Wraps this service's own REST API as agent tools.
//
// Deliberately goes over HTTP rather than calling the route handlers
// directly: the agent is just another API client, authenticating with the
// same `tma_` key as any other consumer. That keeps the tool surface
// identical to the public API (no logic duplicated here) and means the
// agent can only ever touch the inboxes belonging to the key it was given.
const { betaTool } = require('@anthropic-ai/sdk/helpers/beta/json-schema');

const MAX_WAIT_SECONDS = 30;

// `onCall` is invoked after every tool run so the caller can build a
// transcript of what the agent actually did — that trace is the whole
// point of an agent UI, so it's captured here rather than reconstructed.
function buildTools({ apiKey, baseUrl, onCall }) {
  const tool = (def) =>
    betaTool({
      ...def,
      run: async (input) => {
        const result = await def.run(input);
        if (onCall) onCall({ name: def.name, input, result });
        return result;
      },
    });

  // Returns a string either way — a failed tool call should teach the model
  // what went wrong so it can adapt, not blow up the whole run.
  async function call(method, path, body) {
    try {
      const res = await fetch(`${baseUrl}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (res.status === 204) return 'OK (no content)';
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        return `Error ${res.status}: ${data?.error || 'request failed'}`;
      }
      return JSON.stringify(data);
    } catch (err) {
      return `Error: could not reach the API (${err.message})`;
    }
  }

  const inboxId = { type: 'string', description: 'The inbox id returned by create_inbox or list_inboxes' };
  const phoneId = { type: 'string', description: 'The phone id returned by create_phone or list_phones' };
  const noArgs = { type: 'object', properties: {}, required: [] };

  return [
    tool({
      name: 'list_domains',
      description: 'List the mail domains currently available for new inboxes. Call this before create_inbox only if the user asked for a specific domain.',
      inputSchema: noArgs,
      run: () => call('GET', '/api/emails/domains'),
    }),

    tool({
      name: 'create_inbox',
      description:
        'Create a new disposable email inbox and return its id and address. ' +
        'Use prefix only when the user asked for a specific address; otherwise a random one is generated. ' +
        'If the chosen prefix is already taken this returns an error and you should try a different one.',
      inputSchema: {
        type: 'object',
        properties: {
          ttlMinutes: { type: 'integer', description: 'Minutes until the inbox expires (1-1440). Defaults to 15.' },
          prefix: { type: 'string', description: 'Optional custom local part, e.g. "myname" for myname@domain.com' },
          domain: { type: 'string', description: 'Optional domain, must be one returned by list_domains' },
        },
        required: [],
      },
      run: (input) => call('POST', '/api/emails', input),
    }),

    tool({
      name: 'list_inboxes',
      description: 'List all of this account\'s inboxes with their addresses and expiry times.',
      inputSchema: noArgs,
      run: () => call('GET', '/api/emails'),
    }),

    tool({
      name: 'get_messages',
      description: 'Read every message currently in an inbox, including sender, subject and body.',
      inputSchema: { type: 'object', properties: { inboxId }, required: ['inboxId'] },
      run: (input) => call('GET', `/api/emails/${input.inboxId}/messages`),
    }),

    tool({
      name: 'get_otp',
      description:
        'Get the most recent verification code found in an inbox. ' +
        'Returns {"otp": null} when no code has arrived yet — that is normal, not an error. ' +
        'To wait for a code, call this, then wait, then call it again.',
      inputSchema: { type: 'object', properties: { inboxId }, required: ['inboxId'] },
      run: (input) => call('GET', `/api/emails/${input.inboxId}/otp`),
    }),

    tool({
      name: 'extend_inbox',
      description: 'Push back an inbox\'s expiry time so it stays alive longer.',
      inputSchema: {
        type: 'object',
        properties: { inboxId, minutes: { type: 'integer', description: 'Additional minutes to add' } },
        required: ['inboxId', 'minutes'],
      },
      run: (input) => call('PATCH', `/api/emails/${input.inboxId}/extend`, { minutes: input.minutes }),
    }),

    tool({
      name: 'delete_inbox',
      description: 'Permanently delete an inbox. This cannot be undone, so only do it when the user clearly asked.',
      inputSchema: { type: 'object', properties: { inboxId }, required: ['inboxId'] },
      run: (input) => call('DELETE', `/api/emails/${input.inboxId}`),
    }),

    tool({
      name: 'create_phone',
      description:
        'Create a temporary phone number for receiving SMS. ' +
        'Note the deployment may be using a mock provider, in which case the number is not real — say so if it is.',
      inputSchema: {
        type: 'object',
        properties: { ttlMinutes: { type: 'integer', description: 'Minutes until it expires (1-1440). Defaults to 15.' } },
        required: [],
      },
      run: (input) => call('POST', '/api/phones', input),
    }),

    tool({
      name: 'list_phones',
      description: 'List all of this account\'s temporary phone numbers.',
      inputSchema: noArgs,
      run: () => call('GET', '/api/phones'),
    }),

    tool({
      name: 'get_phone_otp',
      description: 'Get the most recent verification code received by SMS. Returns {"otp": null} if nothing has arrived yet.',
      inputSchema: { type: 'object', properties: { phoneId }, required: ['phoneId'] },
      run: (input) => call('GET', `/api/phones/${input.phoneId}/otp`),
    }),

    tool({
      name: 'delete_phone',
      description: 'Permanently release a temporary phone number.',
      inputSchema: { type: 'object', properties: { phoneId }, required: ['phoneId'] },
      run: (input) => call('DELETE', `/api/phones/${input.phoneId}`),
    }),

    tool({
      name: 'wait',
      description:
        `Pause before checking again. Use between get_otp calls when waiting for a code to arrive. ` +
        `Capped at ${MAX_WAIT_SECONDS} seconds per call — to wait longer, call it several times.`,
      inputSchema: {
        type: 'object',
        properties: { seconds: { type: 'integer', description: `How long to pause, 1-${MAX_WAIT_SECONDS}` } },
        required: ['seconds'],
      },
      run: async (input) => {
        const seconds = Math.min(Math.max(1, Number(input.seconds) || 1), MAX_WAIT_SECONDS);
        await new Promise((r) => setTimeout(r, seconds * 1000));
        return `Waited ${seconds}s.`;
      },
    }),
  ];
}

module.exports = { buildTools, MAX_WAIT_SECONDS };
