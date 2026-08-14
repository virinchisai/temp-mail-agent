// Best-effort OTP/verification-code extraction from an email or SMS body.
// Consuming apps still get the raw message too, in case they want to parse
// something we don't catch.

const KEYWORD_PATTERNS = [
  /(?:code|otp|pin|passcode)\s*(?:is|:)?\s*[:\-]?\s*(\d{4,8})/i,
  /(\d{4,8})\s*(?:is your|is the)\s*(?:code|otp|pin|passcode)/i,
  /verification code[^0-9]{0,10}(\d{4,8})/i,
];

const FALLBACK_PATTERN = /\b\d{4,8}\b/;

// A calendar year on its own (e.g. from a quoted "On Aug 14, 2026 at 9:51
// AM ... wrote:" reply header) is almost never a real OTP, and is exactly
// the kind of false positive the bare fallback pattern would otherwise grab.
const LOOKS_LIKE_YEAR = /^(19|20)\d{2}$/;

// Reply/forward chains ("On ... wrote:", quoted "> " lines) are packed with
// dates, phone numbers, and other digit strings that aren't the message's
// own OTP. Cut them before searching.
function stripQuotedReplies(text) {
  if (!text) return text;
  const lines = text.split(/\r?\n/);
  const cutIndex = lines.findIndex(
    (line) => /^\s*on .+wrote:\s*$/i.test(line) || /^\s*>/.test(line)
  );
  return (cutIndex === -1 ? lines : lines.slice(0, cutIndex)).join('\n');
}

function extractOtp(text) {
  if (!text) return null;
  const trimmed = stripQuotedReplies(text);
  for (const pattern of KEYWORD_PATTERNS) {
    const match = trimmed.match(pattern);
    if (match) return match[1];
  }
  const fallback = trimmed.match(FALLBACK_PATTERN);
  if (fallback && !LOOKS_LIKE_YEAR.test(fallback[0])) return fallback[0];
  return null;
}

function findFirstOtp(messages) {
  // messages assumed sorted newest-first
  for (const m of messages) {
    const otp = extractOtp(`${m.subject || ''}\n${m.text || ''}`);
    if (otp) return { otp, message: m };
  }
  return null;
}

module.exports = { extractOtp, findFirstOtp };
