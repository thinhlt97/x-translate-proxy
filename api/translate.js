// api/translate.js — Vercel Serverless Function dùng GROQ.
// Hai chế độ:
//   1) Dịch: body { tweets: [...] }  -> { tweets: [ {sentences:[...]} ] }  (vocab có thêm IPA)
//   2) Tạo đề ôn tập: body { quiz: [ {word, ipa, pos, meaning_vi} ] } -> { questions: [...] }
//
// Khóa GROQ_API_KEY đặt trong Environment Variables của Vercel.
// Lấy khóa: https://console.groq.com -> API Keys.

const MODEL = "llama-3.3-70b-versatile";

const SYS_TRANSLATE = `You are a bilingual English-Vietnamese teacher specialising in football/soccer news from X.
You will receive SEVERAL tweets, each marked "TWEET 1:", "TWEET 2:", etc.
For EACH tweet, break it into sentences and translate.
Return ONLY valid JSON (no markdown, no preamble) with this exact shape:
{"tweets":[
  {"sentences":[{"en":"<English sentence verbatim>","vi":"<natural Vietnamese translation>","vocab":[{"word":"<word/phrase>","ipa":"<IPA pronunciation, e.g. /ˈmedɪkl/>","pos":"<từ loại tiếng Việt>","meaning_vi":"<nghĩa tiếng Việt>","note":"<ghi chú ngữ cảnh hoặc rỗng>"}]}]}
]}
The "tweets" array MUST have exactly one entry per input tweet, in the SAME order.
Keep each English sentence verbatim. ALWAYS include the "ipa" field for every vocab item (British or General American IPA, wrapped in slashes).
Prioritise football jargon, idioms, phrasal verbs, transfer-market terms (e.g. "over the line", "medical", "deadline day", "personal terms", "release clause").
2-5 vocab items per sentence. Vietnamese must be fluent. Output JSON only.`;

const SYS_QUIZ = `You create English vocabulary quizzes for Vietnamese learners of English.
You will receive a list of English words/phrases with their meaning.
Create EXACTLY 10 multiple-choice questions. EVERYTHING must be in ENGLISH ONLY
(every question and every answer option in English). Each question tests the meaning or
correct usage of one of the given words. Vary the style: definition matching, fill-in-the-blank
sentences, and synonym choice. Each question has exactly 4 options and exactly one correct answer.
If there are fewer than 10 words, still create 10 questions by reusing words from different angles.
Return ONLY valid JSON (no markdown, no preamble) with this exact shape:
{"questions":[{"question":"<English question>","options":["<A>","<B>","<C>","<D>"],"correct":<index 0-3 of the correct option>}]}
Output JSON only.`;

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
    const body = req.body || {};

    // ===== Chế độ tạo đề ôn tập =====
    if (Array.isArray(body.quiz)) {
      if (!body.quiz.length) return res.status(400).json({ error: "Danh sách từ vựng rỗng." });
      const wordList = body.quiz
        .map((v, i) => `${i + 1}. ${v.word}${v.meaning_vi ? " (nghĩa: " + v.meaning_vi + ")" : ""}`)
        .join("\n");
      const out = await callGroq(SYS_QUIZ, "Words:\n" + wordList, 3000);
      if (out.error) return res.status(502).json({ error: out.error });
      const questions = Array.isArray(out.json.questions) ? out.json.questions : [];
      return res.status(200).json({ questions });
    }

    // ===== Chế độ dịch =====
    let tweets = body.tweets;
    if (!Array.isArray(tweets)) {
      const single = body.text;
      tweets = (single && typeof single === "string") ? [single] : null;
    }
    if (!tweets || !tweets.length) {
      return res.status(400).json({ error: "Thiếu 'tweets' (mảng), 'text', hoặc 'quiz'." });
    }
    if (tweets.length > 12) return res.status(400).json({ error: "Tối đa 12 tweet mỗi lần." });
    if (tweets.join("").length > 8000) return res.status(400).json({ error: "Tổng nội dung quá dài." });

    const userMsg = tweets.map((t, i) => `TWEET ${i + 1}:\n${t}`).join("\n\n");
    const out = await callGroq(SYS_TRANSLATE, userMsg, 3500);
    if (out.error) return res.status(502).json({ error: out.error });
    const parsed = out.json;
    const arr = Array.isArray(parsed.tweets) ? parsed.tweets
              : (Array.isArray(parsed.sentences) ? [{ sentences: parsed.sentences }] : []);
    return res.status(200).json({ tweets: arr });
  } catch (e) {
    return res.status(502).json({ error: "Proxy lỗi: " + (e && e.message ? e.message : String(e)) });
  }
}

// Gọi Groq, trả { json } hoặc { error }
async function callGroq(system, user, maxTokens) {
  const upstream = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + process.env.GROQ_API_KEY,
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      response_format: { type: "json_object" },
      temperature: 0.3,
      max_tokens: maxTokens,
    }),
  });
  if (!upstream.ok) {
    const detail = await upstream.text();
    return { error: "Groq " + upstream.status + ": " + detail.slice(0, 400) };
  }
  const data = await upstream.json();
  const raw = (data.choices?.[0]?.message?.content || "")
    .replace(/```json|```/g, "").trim();
  try {
    return { json: JSON.parse(raw) };
  } catch {
    return { error: "Không phân tích được JSON từ Groq" };
  }
}
