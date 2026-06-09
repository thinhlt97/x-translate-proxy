// api/translate.js — Vercel Serverless Function dùng GEMINI, CÓ gộp nhiều tweet/lần.
//
// Đặt ở Vercel (vùng Mỹ) để tránh lỗi chặn vùng của Gemini.
// Nhận {tweets: [...]} từ web app, dịch tất cả trong MỘT lần gọi, trả {tweets: [...]}.
//
// Khóa GEMINI_API_KEY đặt trong Environment Variables của Vercel.
// Lấy khóa miễn phí: https://aistudio.google.com -> "Get API key".

// gemini-2.5-flash: dịch tự nhiên hơn. Muốn hạn mức miễn phí cao hơn (đổi lấy chất
// lượng thấp hơn chút) thì dùng "gemini-2.5-flash-lite".
const MODEL = "gemini-2.5-flash";

const SYS = `You are a bilingual English-Vietnamese teacher specialising in football/soccer news from X.
You will receive SEVERAL tweets, each marked "TWEET 1:", "TWEET 2:", etc.
For EACH tweet, break it into sentences and translate.
Return ONLY valid JSON (no markdown, no preamble) with this exact shape:
{"tweets":[
  {"sentences":[{"en":"<English sentence verbatim>","vi":"<natural Vietnamese translation>","vocab":[{"word":"<word/phrase>","pos":"<từ loại tiếng Việt>","meaning_vi":"<nghĩa>","note":"<ghi chú ngữ cảnh hoặc rỗng>"}]}]}
]}
The "tweets" array MUST have exactly one entry per input tweet, in the SAME order as the input.
Keep each English sentence verbatim. Prioritise football jargon, idioms, phrasal verbs,
transfer-market terms (e.g. "over the line", "medical", "deadline day", "personal terms", "release clause").
2-5 vocab items per sentence. Vietnamese must be fluent and natural. Output JSON only.`;

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
    // Nhận mảng tweets (gộp nhiều bài). Vẫn chấp nhận {text} đơn lẻ cho tương thích.
    let tweets = req.body && req.body.tweets;
    if (!Array.isArray(tweets)) {
      const single = req.body && req.body.text;
      tweets = (single && typeof single === "string") ? [single] : null;
    }
    if (!tweets || !tweets.length) {
      return res.status(400).json({ error: "Thiếu 'tweets' (mảng) hoặc 'text'." });
    }
    if (tweets.length > 12) {
      return res.status(400).json({ error: "Tối đa 12 tweet mỗi lần." });
    }
    const totalLen = tweets.join("").length;
    if (totalLen > 8000) {
      return res.status(400).json({ error: "Tổng nội dung quá dài (tối đa 8000 ký tự)." });
    }

    // Đánh số từng tweet để model trả kết quả đúng thứ tự
    const userMsg = tweets.map((t, i) => `TWEET ${i + 1}:\n${t}`).join("\n\n");

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
        contents: [{ role: "user", parts: [{ text: userMsg }] }],
        generationConfig: {
          responseMimeType: "application/json",
          maxOutputTokens: 8192,   // đủ chỗ cho nhiều tweet + phần "suy nghĩ" của model
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
    // Luôn trả về dạng { tweets: [...] }
    const arr = Array.isArray(parsed.tweets) ? parsed.tweets
              : (Array.isArray(parsed.sentences) ? [{ sentences: parsed.sentences }] : []);
    return res.status(200).json({ tweets: arr });
  } catch (e) {
    return res.status(502).json({ error: "Proxy lỗi: " + (e && e.message ? e.message : String(e)) });
  }
}
