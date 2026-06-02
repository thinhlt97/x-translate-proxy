// api/translate.js — Vercel Serverless Function dùng GEMINI (chạy mặc định ở Mỹ, iad1).
//
// Vì sao đặt ở Vercel:
//  - Cloudflare Worker hay chạy qua Hong Kong -> Gemini chặn ("User location is not supported").
//  - Vercel mặc định chạy hàm ở Washington D.C. (Mỹ), vùng Gemini phục vụ -> hết lỗi.
//
// Khóa GEMINI_API_KEY đặt trong Environment Variables của Vercel (không nằm trong code).
// Lấy khóa miễn phí: https://aistudio.google.com -> "Get API key".

// Flash-Lite: hạn mức miễn phí cao nhất. Muốn dịch tốt hơn đổi "gemini-2.5-flash".
const MODEL = "gemini-2.5-flash";

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

    const url =
      "https://generativelanguage.googleapis.com/v1beta/models/" +
      MODEL + ":generateContent";

    const upstream = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": process.env.GEMINI_API_KEY,
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYS }] },
        contents: [{ role: "user", parts: [{ text }] }],
        generationConfig: {
          responseMimeType: "application/json",
          maxOutputTokens: 4096,
          temperature: 0.3,
        },
      }),
    });

    if (!upstream.ok) {
      const detail = await upstream.text();
      return res.status(502).json({ error: "Gemini " + upstream.status + ": " + detail.slice(0, 400) });
    }

    const data = await upstream.json();
    const raw = (data.candidates?.[0]?.content?.parts || [])
      .map((p) => p.text || "")
      .join("\n")
      .replace(/```json|```/g, "")
      .trim();

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return res.status(502).json({ error: "Không phân tích được JSON từ Gemini", raw });
    }
    return res.status(200).json(parsed);
  } catch (e) {
    return res.status(502).json({ error: "Proxy lỗi: " + (e && e.message ? e.message : String(e)) });
  }
}
