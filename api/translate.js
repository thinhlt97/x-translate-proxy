// api/translate.js — Vercel Serverless Function (chạy mặc định ở Mỹ, iad1).
//
// Vì sao đặt ở Vercel thay vì Cloudflare Worker:
//  - Cloudflare Worker hay chạy qua Hong Kong -> Anthropic/Gemini chặn theo vùng.
//  - Vercel mặc định chạy hàm ở Washington D.C. (Mỹ), là vùng được Anthropic phục vụ.
//
// Khóa ANTHROPIC_API_KEY đặt trong phần Environment Variables của Vercel (không nằm trong code).

const MODEL = "claude-haiku-4-5-20251001"; // rẻ; muốn tốt hơn đổi "claude-sonnet-4-6"

const SYS = `You are a bilingual English-Vietnamese teacher specialising in football/soccer news from X.
Return ONLY valid JSON (no markdown, no preamble) with this shape:
{"sentences":[{"en":"<English sentence verbatim>","vi":"<natural Vietnamese translation>",
"vocab":[{"word":"<word/phrase>","pos":"<từ loại tiếng Việt>","meaning_vi":"<nghĩa>","note":"<ghi chú ngữ cảnh hoặc rỗng>"}]}]}
Split the tweet into sentences, keep English verbatim. Prioritise football jargon, idioms, phrasal verbs,
transfer-market terms (e.g. "over the line", "medical", "deadline day", "personal terms", "release clause").
2-5 vocab items per sentence. Vietnamese must be fluent. Output JSON only.`;

// Chỉ cho phép web app của bạn gọi (đỡ bị người lạ xài chùa khóa).
const ALLOWED_ORIGINS = [
  "https://my-x-news.thinhlt1069-xnews.workers.dev",
  "http://localhost:8788",
];

export default async function handler(req, res) {
  const origin = req.headers.origin || "";
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  res.setHeader("Access-Control-Allow-Origin", allow);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Chỉ nhận POST" });

  try {
    const text = req.body && req.body.text;
    if (!text || typeof text !== "string") {
      return res.status(400).json({ error: "Thiếu trường 'text'." });
    }
    if (text.length > 2000) {
      return res.status(400).json({ error: "Đoạn quá dài (tối đa 2000 ký tự)." });
    }

    const upstream = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1500,
        system: SYS,
        messages: [{ role: "user", content: text }],
      }),
    });

    if (!upstream.ok) {
      const detail = await upstream.text();
      return res.status(502).json({ error: "Claude " + upstream.status + ": " + detail.slice(0, 400) });
    }

    const data = await upstream.json();
    const raw = (data.content || [])
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("\n")
      .replace(/```json|```/g, "")
      .trim();

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return res.status(502).json({ error: "Không phân tích được JSON từ Claude", raw });
    }
    return res.status(200).json(parsed);
  } catch (e) {
    return res.status(502).json({ error: "Proxy lỗi: " + (e && e.message ? e.message : String(e)) });
  }
}
