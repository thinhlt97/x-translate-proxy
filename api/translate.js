// api/translate.js — Vercel Serverless Function: hỗ trợ CẢ Groq LẪN Gemini.
// Mỗi yêu cầu dịch/tạo đề kèm trường "provider": "gemini" hoặc "groq".
//
// Chế độ:
//   1) Kéo tin: body { source: "handle" }                              -> { tweets:[{text,created_at}] }
//   2) Dịch:    body { tweets:[...], provider:"gemini"|"groq" }         -> { tweets:[{sentences:[...]}] }
//   3) Tạo đề:  body { quiz:[{word,...}], provider:"gemini"|"groq" }     -> { questions:[...] }
//
// Biến môi trường trên Vercel: GEMINI_API_KEY, GROQ_API_KEY, TWITTERAPI_KEY.

const GEMINI_MODEL = "gemini-2.5-flash";
const GROQ_MODEL = "llama-3.3-70b-versatile";

const SYS_TRANSLATE = `You are a bilingual English-Vietnamese teacher specialising in football/soccer news from X.
You will receive SEVERAL tweets, each marked "TWEET 1:", "TWEET 2:", etc.
For EACH tweet, break it into sentences and translate.
Return ONLY valid JSON (no markdown, no preamble) with this exact shape:
{"tweets":[
  {"sentences":[{"en":"<English sentence verbatim>","vi":"<natural Vietnamese translation>","vocab":[{"word":"<word/phrase>","ipa":"<IPA pronunciation, e.g. /ˈmedɪkl/>","pos":"<từ loại tiếng Việt>","meaning_vi":"<nghĩa tiếng Việt>","note":"<ghi chú ngữ cảnh hoặc rỗng>"}]}]}
]}
The "tweets" array MUST have exactly one entry per input tweet, in the SAME order.
Keep each English sentence verbatim. ALWAYS include the "ipa" field for every vocab item (IPA in slashes).
Prioritise football jargon, idioms, phrasal verbs, transfer-market terms.
2-5 vocab items per sentence. Vietnamese must be fluent and natural. Output JSON only.`;

const SYS_QUIZ = `You create CHALLENGING English vocabulary quizzes for Vietnamese learners.
You receive a list of TARGET English words/phrases (the learner's study list) with their meanings.
Create EXACTLY 10 multiple-choice questions. EVERYTHING in ENGLISH ONLY.

CRITICAL DIFFICULTY RULES — the quiz must be hard to guess:
- All 4 options must be PLAUSIBLE and of the SAME kind (all real English words of the same part of speech, OR all full sentences). The learner must NOT be able to find the answer just by spotting "the only familiar word".
- Use OTHER words from the study list as the wrong options whenever possible. If a question targets word X, use other study-list words — or close real synonyms / same football-domain terms — as the 3 distractors.
- NEVER use nonsense or obviously unrelated filler as options.
- Mix styles across the 10: (a) definition -> choose the word; (b) fill-in-the-blank football sentence where all 4 fit grammatically but only one fits the meaning; (c) closest synonym; (d) correct usage in context.
- Exactly one correct option. VARY the position of the correct answer (not always the same letter).
Return ONLY valid JSON: {"questions":[{"question":"...","options":["A","B","C","D"],"correct":<0-3>}]}
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
    const provider = body.provider === "groq" ? "groq" : "gemini";   // mặc định gemini

    // ===== 1) KÉO TIN =====
    if (typeof body.source === "string") {
      const handle = body.source.trim();
      if (!/^[A-Za-z0-9_]{1,30}$/.test(handle)) return res.status(400).json({ error: "Tên kênh không hợp lệ." });
      const tw = await fetchSource(handle);
      if (tw.error) return res.status(502).json({ error: tw.error });
      return res.status(200).json({ tweets: tw.tweets });
    }

    // ===== 3) TẠO ĐỀ =====
    if (Array.isArray(body.quiz)) {
      if (!body.quiz.length) return res.status(400).json({ error: "Danh sách từ vựng rỗng." });
      const wordList = body.quiz
        .map((v, i) => `${i + 1}. ${v.word}${v.meaning_vi ? " — meaning: " + v.meaning_vi : ""}`)
        .join("\n");
      const out = await callLLM(provider, SYS_QUIZ, "Study list:\n" + wordList, 4000);
      if (out.error) return res.status(502).json({ error: out.error });
      return res.status(200).json({ questions: Array.isArray(out.json.questions) ? out.json.questions : [] });
    }

    // ===== 2) DỊCH =====
    let tweets = body.tweets;
    if (!Array.isArray(tweets)) {
      const single = body.text;
      tweets = (single && typeof single === "string") ? [single] : null;
    }
    if (!tweets || !tweets.length) return res.status(400).json({ error: "Thiếu 'source', 'tweets', hoặc 'quiz'." });
    if (tweets.length > 12) return res.status(400).json({ error: "Tối đa 12 tweet mỗi lần." });
    if (tweets.join("").length > 8000) return res.status(400).json({ error: "Tổng nội dung quá dài." });

    const userMsg = tweets.map((t, i) => `TWEET ${i + 1}:\n${t}`).join("\n\n");
    const out = await callLLM(provider, SYS_TRANSLATE, userMsg, 8192);
    if (out.error) return res.status(502).json({ error: out.error });
    const parsed = out.json;
    const arr = Array.isArray(parsed.tweets) ? parsed.tweets
              : (Array.isArray(parsed.sentences) ? [{ sentences: parsed.sentences }] : []);
    return res.status(200).json({ tweets: arr });
  } catch (e) {
    return res.status(502).json({ error: "Proxy lỗi: " + (e && e.message ? e.message : String(e)) });
  }
}

// Chọn nhà cung cấp
async function callLLM(provider, system, user, maxTokens) {
  return provider === "groq"
    ? callGroq(system, user, maxTokens)
    : callGemini(system, user, maxTokens);
}

async function callGemini(system, user, maxTokens) {
  const url = "https://generativelanguage.googleapis.com/v1beta/models/" + GEMINI_MODEL + ":generateContent";
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts: [{ text: user }] }],
      generationConfig: { responseMimeType: "application/json", maxOutputTokens: maxTokens, temperature: 0.4 },
    }),
  });
  if (!r.ok) { const d = await r.text(); return { error: "Gemini " + r.status + ": " + d.slice(0, 400) }; }
  const data = await r.json();
  const raw = (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("\n").replace(/```json|```/g, "").trim();
  try { return { json: JSON.parse(raw) }; } catch { return { error: "Không phân tích được JSON từ Gemini" }; }
}

async function callGroq(system, user, maxTokens) {
  const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer " + process.env.GROQ_API_KEY },
    body: JSON.stringify({
      model: GROQ_MODEL,
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
      response_format: { type: "json_object" },
      temperature: 0.4,
      max_tokens: Math.min(maxTokens, 4000),   // Groq tính max_tokens vào hạn mức TPM
    }),
  });
  if (!r.ok) { const d = await r.text(); return { error: "Groq " + r.status + ": " + d.slice(0, 400) }; }
  const data = await r.json();
  const raw = (data.choices?.[0]?.message?.content || "").replace(/```json|```/g, "").trim();
  try { return { json: JSON.parse(raw) }; } catch { return { error: "Không phân tích được JSON từ Groq" }; }
}

// Kéo tweet của một kênh từ twitterapi.io, lọc 24h, chỉ giữ text gốc.
async function fetchSource(handle) {
  const key = process.env.TWITTERAPI_KEY;
  if (!key) return { error: "Chưa đặt TWITTERAPI_KEY trên Vercel." };
  const url = "https://api.twitterapi.io/twitter/user/last_tweets?userName=" + encodeURIComponent(handle) + "&count=40";
  const r = await fetch(url, { headers: { "x-api-key": key } });
  if (!r.ok) { const d = await r.text(); return { error: "twitterapi " + r.status + ": " + d.slice(0, 300) }; }
  const payload = await r.json();
  const raw = payload.tweets || payload?.data?.tweets || payload.data || [];
  const since = Date.now() - 24 * 3600 * 1000;
  const tweets = [];
  for (const tw of raw) {
    let text = tw.text || tw.full_text || "";
    if (/^RT @/.test(text) || tw.retweeted_tweet) continue;
    if (tw.isReply || tw.inReplyToId) continue;
    const t = Date.parse(tw.createdAt || tw.created_at || "");
    if (!isNaN(t) && t < since) continue;
    text = text.replace(/https:\/\/t\.co\/\w+/g, "").replace(/[ \t]+/g, " ").trim();
    if (!text) continue;
    let created = "";
    if (!isNaN(t)) created = new Date(t).toLocaleString("vi-VN", {
      timeZone: "Asia/Ho_Chi_Minh", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
    tweets.push({ text, created_at: created });
  }
  return { tweets };
}
