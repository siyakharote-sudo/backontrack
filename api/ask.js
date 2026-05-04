function mustGetAnthropicKey() {
  const key = String(process.env.ANTHROPIC_API_KEY || "").trim();
  if (!key) {
    const err = new Error("Missing ANTHROPIC_API_KEY in Vercel environment.");
    err.statusCode = 500;
    throw err;
  }
  return key;
}

function buildTutorPrompt({ subject, doubt }) {
  const day = new Date().toISOString().slice(0, 10);
  const cleanedDoubt = String(doubt || "").trim();
  if (!cleanedDoubt) return "";

  return `You are a strict but kind engineering tutor for an Indian college student.

Goal: help me solve my doubt with steps and clear reasoning.

Constraints:
- Keep it exam-oriented (most likely questions, shortcuts where valid).
- If it’s a numerical problem, show steps + final answer.
- If it’s theory, give a structured explanation + 5 quick revision bullets.
- Ask 1-2 clarifying questions ONLY if absolutely necessary.

Context:
- Date: ${day}
- Subject: ${String(subject || "Not specified").trim() || "Not specified"}

My doubt:
${cleanedDoubt}
`;
}

function sendJson(res, statusCode, obj) {
  const body = JSON.stringify(obj);
  res.statusCode = statusCode;
  res.setHeader("content-type", "application/json; charset=utf-8");
  // Same-origin on Vercel, but keeping CORS open doesn't hurt.
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
  res.setHeader("access-control-allow-headers", "content-type");
  res.end(body);
}

async function readJson(req) {
  return await new Promise((resolve, reject) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 1_000_000) {
        const err = new Error("Request too large.");
        err.statusCode = 413;
        reject(err);
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        const err = new Error("Invalid JSON body.");
        err.statusCode = 400;
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

module.exports = async function handler(req, res) {
  try {
    if (req.method === "OPTIONS") return sendJson(res, 204, {});
    if (req.method !== "POST") return sendJson(res, 405, { error: "Method not allowed" });

    const body = await readJson(req);
    const subject = String(body?.subject || "").trim();
    const doubt = String(body?.doubt || body?.question || "").trim();
    const model = String(body?.model || "claude-3-5-sonnet-latest").trim();

    if (!doubt) return sendJson(res, 400, { error: "Missing 'question' (or 'doubt')." });

    const prompt = buildTutorPrompt({ subject, doubt });
    if (!prompt) return sendJson(res, 400, { error: "Empty prompt." });

    const apiKey = mustGetAnthropicKey();
    const upstream = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: 800,
        temperature: 0.2,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    const data = await upstream.json().catch(() => null);
    if (!upstream.ok) {
      return sendJson(res, upstream.status, {
        error: "Anthropic request failed.",
        status: upstream.status,
        details: data,
      });
    }

    const text =
      data?.content?.find?.((c) => c?.type === "text")?.text ??
      (Array.isArray(data?.content) ? data.content.map((c) => c?.text).filter(Boolean).join("\n") : "") ??
      "";

    return sendJson(res, 200, { text, raw: data });
  } catch (e) {
    const status = Number(e?.statusCode) || 500;
    return sendJson(res, status, { error: e?.message || "Server error" });
  }
};

