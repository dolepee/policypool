export async function callHandler(handler, {
  method = "GET",
  url = "/api/covered-job-receipt",
  headers = {},
  body = undefined,
  query = {},
} = {}) {
  const responseHeaders = {};
  let statusCode = 200;
  let sent = "";
  let ended = false;

  const req = {
    method,
    url,
    headers: Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value])),
    body,
    query,
  };

  const res = {
    setHeader(key, value) {
      responseHeaders[key.toLowerCase()] = value;
    },
    status(code) {
      statusCode = code;
      return this;
    },
    send(value) {
      sent = value;
      ended = true;
      return this;
    },
    end(value = "") {
      sent = value;
      ended = true;
      return this;
    },
  };

  await handler(req, res);
  return {
    statusCode,
    headers: responseHeaders,
    body: sent,
    ended,
    json() {
      return sent ? JSON.parse(sent) : null;
    },
  };
}

export function decodePaymentRequired(value) {
  return JSON.parse(Buffer.from(value, "base64").toString("utf8"));
}
