// api/translate.js — Vercel Serverless Function: hỗ trợ Gemini, Groq VÀ Claude.
// Mỗi yêu cầu dịch/tạo đề kèm trường "provider":
//   "gemini" | "groq" | "claude-haiku" | "claude-sonnet"
//
// Chế độ:
//   1) Kéo tin: body { source: "handle" }                              -> { tweets:[{text,created_at,ts}] }  (ts: ms epoch|null)
//   2) Dịch:    body { tweets:[...], provider:<provider> }             -> { tweets:[{sentences:[...]}] }
//   3) Tạo đề:  body { quiz:[{word,...}], provider:<provider> }         -> { questions:[...] }
//   5) Luyện nghe: body { listen:[{word,...}], provider:<provider> }    -> { title, transcript:[{speaker,text,vi}], questions:[...5 mc A/B/C/D], dictation:[{text,answers,vi}] }
//   6) TTS nghe:  body { tts:[{speaker,text}] }                         -> { audio:<base64 PCM>, mime }  (Gemini TTS đa giọng)
//   7) Xếp hạng gợi ý: body { rank:{ profile:{topics,follows,emerging}, tweets:[{id,text,author}] }, provider } -> { scores:[{id,score,topic}] }
//   8) Hồ sơ sở thích: body { interest:{ topics:[label...], reads:[text...] }, provider } -> { weights, keywords, emerging }
//
// Biến môi trường trên Vercel: GEMINI_API_KEY, GROQ_API_KEY, ANTHROPIC_API_KEY, TWITTERAPI_KEY.

const GEMINI_MODEL = "gemini-2.5-flash";
const GROQ_MODEL = "llama-3.3-70b-versatile";
const TTS_MODEL = "gemini-2.5-flash-preview-tts";   // model Gemini đọc thành tiếng (đa giọng)
const TTS_VOICES = ["Puck", "Kore"];                // 2 giọng phân biệt cho 2 người trong hội thoại
// Map provider -> model Claude (model ID không thêm hậu tố ngày tháng).
const CLAUDE_MODELS = {
  "claude-haiku": "claude-haiku-4-5",
  "claude-sonnet": "claude-sonnet-4-6",
};
// "gemini"      = key trả phí (GEMINI_API_KEY)        -> nút "Gemini Pro"
// "gemini-free" = key miễn phí (GEMINI_FREE_API_KEY)  -> nút "Gemini"
const ALLOWED_PROVIDERS = ["gemini", "gemini-free", "groq", "claude-haiku", "claude-sonnet"];

const SYS_TRANSLATE = `You are a bilingual English-Vietnamese teacher specialising in football/soccer news from X.
You will receive SEVERAL tweets, each marked "TWEET 1:", "TWEET 2:", etc.
For EACH tweet, break it into sentences and translate.
Return ONLY valid JSON (no markdown, no preamble) with this exact shape:
{"tweets":[
  {"sentences":[{"en":"<English sentence verbatim>","vi":"<natural Vietnamese translation>","vocab":[{"word":"<word/phrase>","ipa":"<IPA pronunciation, e.g. /ˈmedɪkl/>","pos":"<từ loại tiếng Việt>","meaning_vi":"<nghĩa tiếng Việt TRONG CÂU NÀY>","note":"<ghi chú ngữ cảnh hoặc rỗng>","collocations":"<2-4 collocation tiếng Anh phổ biến cho nghĩa TRONG CÂU, cách nhau bằng dấu phẩy, hoặc rỗng>","other_meanings":[{"pos":"<từ loại tiếng Việt>","meaning_vi":"<một nghĩa KHÁC của từ>","collocations":"<1-3 cụm từ / collocation tiếng Anh phổ biến ở nghĩa này, cách nhau bằng dấu phẩy>"}]}]}]}
]}
The "tweets" array MUST have exactly one entry per input tweet, in the SAME order.
Keep each English sentence verbatim. ALWAYS include the "ipa" field for every vocab item (IPA in slashes).
Prioritise football jargon, idioms, phrasal verbs, transfer-market terms.
2-5 vocab items per sentence. Vietnamese must be fluent and natural.

"meaning_vi" is the meaning of the word AS USED IN THIS SENTENCE. "collocations" are common English collocations/phrases for THAT in-sentence meaning (comma-separated; "" if none).
"other_meanings" lists OTHER common meanings of the same word that DIFFER from the in-sentence meaning, ordered from MOST common to LEAST common. For each: its part of speech, a short Vietnamese meaning, and a few common English collocations/phrases for that sense. Include AT MOST 3, and keep them concise. If the word has no other common meaning (e.g. a proper noun or a term with a single sense), use an empty array [].
Output JSON only.`;

const SYS_QUIZ = `You create CHALLENGING English vocabulary quizzes for Vietnamese learners.
You receive a list of TARGET English words/phrases (the learner's study list) with their meanings.
Create EXACTLY 10 multiple-choice questions, each with EXACTLY 5 options (A/B/C/D/E). EVERYTHING in ENGLISH ONLY.

VARIETY IS MANDATORY — do NOT make the quiz monotonous. The learner is bored of quizzes that are all fill-in-the-blank.
Across the 10 questions you MUST use a MIX of the formats below. NO single format may be used for more than 3 of the 10 questions. Aim for roughly this spread:
  (A) DEFINITION -> WORD (about 2): give an English definition/description, the 5 options are candidate words; pick the one that matches.
  (B) FILL-IN-THE-BLANK (at most 2-3): a football sentence with a gap "____"; all 5 options fit grammatically but only one fits the meaning.
  (C) CORRECT USAGE (about 2): ask e.g. 'Which sentence uses "X" correctly?' — give 5 full sentences, only ONE uses the target word X correctly (others misuse it: wrong meaning, wrong collocation, or wrong part of speech).
  (D) CLOSEST IN MEANING (about 1-2): 'Which word/phrase is closest in meaning to "X"?' — 5 real words, one is the best synonym.
  (E) ODD ONE OUT / WRONG USAGE (about 1-2): e.g. 'In which sentence is "X" used INCORRECTLY?' or 'Which option is NOT a correct synonym of "X"?'.
When a question targets a specific study word, name it in quotes inside the question text (e.g. the word "strip").

WORD FORM — the form given in the study list is only a LABEL for the word family. NEVER feel bound to it. Use whatever form makes the sentence natural, and deliberately VARY the form across the 10 questions:
- INFLECTIONS: verb tense/aspect (-ing, -ed, -s, past participle), noun plural, comparative/superlative.
- DERIVED FORMS across parts of speech, in EITHER direction. A study-list adjective may be tested as its noun or adverb; a verb as its noun / agent noun / adjective; a noun as its verb or adjective. Examples: "aggressive" -> "aggression"/"aggressively"; "sign" -> "signing"/"signature"/"signed"; "creative" -> "creativity"/"creatively"; "decide" -> "decision"/"decisive"/"decisively"; "strength" -> "strengthen"/"strong".
- A question may test a derived form directly (e.g. define the noun "aggression" while the study word was "aggressive"), as long as the tested word clearly belongs to the same word family. When you quote the word in the question, quote the FORM YOU ACTUALLY USED.
- This applies to the target word AND to distractors AND to review words.

MEANING COVERAGE — a study word may come with SEVERAL meanings (shown after "meanings:" separated by " | "; a word can be a verb in one sense and a noun in another).
- For each word, pick ONE of its meanings AT RANDOM as the meaning the question actually tests — do NOT always default to the first meaning listed. Across the 10 questions, spread the choices so different words test different senses (some first sense, some a later sense).
- Test the chosen sense honestly: the correct option and the question context must match THAT sense, not another one.
- A different sense of the SAME word makes an excellent distractor (e.g. test "strip" = take off, and offer a sentence using "strip" = narrow piece of land as a wrong option). Use this trick when it fits.

CRITICAL DIFFICULTY RULES — the quiz must be hard to guess:
- All 5 options must be PLAUSIBLE and of the SAME kind (all real English words of the same part of speech, OR all full grammatical sentences). The learner must NOT be able to find the answer just by spotting "the only familiar word" or "the only real word".
- Use OTHER words from the study list as the wrong options whenever possible. If a question targets word X, use other study-list words — or close real synonyms / same football-domain terms — as the 4 distractors.
- NEVER use nonsense or obviously unrelated filler as options. Never pad to 5 options with a weak throwaway option — if you cannot invent 5 strong options for an idea, choose a different question idea.
- Exactly one correct option. VARY the position of the correct answer across all 5 letters (not always the same letter, and do not avoid E).

REVIEW WORDS (optional) — you may ALSO receive a separate REVIEW list of words the learner studied earlier and should be reminded of.
- Reuse these REVIEW words HEAVILY so the learner keeps meeting them: put them INSIDE question sentences (as context words in fill-in-the-blank / usage / definition / correct-usage items) AND use them as the WRONG answer options (distractors). Having 5 options gives you MORE distractor slots — fill them with review words. A single question may reuse several review words at once — e.g. 4 of the 5 options can be review words.
- Aim to use MOST of the review words you are given, and make each review word that you use appear at least once across the 10 questions. Spread them across many questions, not all in one.
- Review words may also appear in any inflected/derived form and in any of their meanings.
- HARD CONSTRAINT: naturalness wins over quantity. Only place a review word where it genuinely fits the sentence/option grammatically and in meaning. NEVER force a review word into a sentence where it reads awkwardly or makes the sentence nonsensical, and never let review words turn an option into an implausible distractor. It is fine to leave a review word unused if it cannot be placed naturally.
- Do NOT dedicate a whole question to testing a REVIEW word (the 10 questions still TARGET the study list) and do NOT reveal or mark which words are review words. If there is no REVIEW list, ignore this section.

For EACH question also provide, FOR THE VIETNAMESE LEARNER, written IN VIETNAMESE:
- "vi": a natural Vietnamese translation of the question. Translate the question stem; if the question or the correct option is a full English sentence, translate that sentence too so the learner understands its meaning.
- "explain": a short Vietnamese explanation of WHY the correct option is right — what the target word means here (state the sense being tested, and the word form used if it differs from the study list) and, briefly, why the other options are wrong (wrong meaning / wrong usage / not a synonym). Keep it 1-3 sentences, concrete.
(These two fields are the ONLY Vietnamese in the output; the question and all 5 options stay English-only.)

Return ONLY valid JSON: {"questions":[{"question":"...","options":["A","B","C","D","E"],"correct":<0-4>,"vi":"<dịch tiếng Việt>","explain":"<giải thích tiếng Việt>"}]}
Every "options" array MUST have exactly 5 items and "correct" MUST be 0..4.
Output JSON only.`;

// Một dòng mô tả từ cho đề ôn tập: gộp nghĩa chính + các nghĩa khác để model tự bốc nghĩa ra đề.
// Ví dụ: `strip (v.) — meanings: cởi (áo) | (n.) dải đất hẹp | (n.) áo đấu`
function fmtQuizWord(v) {
  const senses = [];
  if (v.meaning_vi) senses.push((v.pos ? `(${v.pos}) ` : "") + v.meaning_vi);
  (Array.isArray(v.other_meanings) ? v.other_meanings : []).forEach((o) => {
    if (o && o.meaning_vi) senses.push((o.pos ? `(${o.pos}) ` : "") + o.meaning_vi);
  });
  return v.word + (senses.length ? " — meanings: " + senses.join(" | ") : "");
}

// Bỏ câu hỏi hỏng (thiếu phương án / correct trỏ ra ngoài) thay vì để frontend hiện câu vô nghĩa.
function validQuizQuestion(q) {
  return q && typeof q.question === "string" && q.question.trim()
    && Array.isArray(q.options) && q.options.length >= 3 && q.options.length <= 5
    && Number.isInteger(q.correct) && q.correct >= 0 && q.correct < q.options.length;
}

const SYS_LISTEN = `You design IELTS-style LISTENING practice for a Vietnamese learner.
You receive a list of TARGET English words/phrases (the learner's study list).
Produce THREE things: (1) ONE natural spoken DIALOGUE, (2) EXACTLY 5 multiple-choice comprehension questions, and (3) a DICTATION (gap-fill) section.

DIALOGUE rules:
- A natural conversation between EXACTLY TWO named speakers (e.g. "Tom" and "Anna"), like IELTS Listening Section 1 (everyday/social) or Section 3 (a study/work discussion).
- About 260-360 words total, split into short alternating turns. Realistic, flowing spoken English (contractions, follow-up questions, small reactions, mild digressions). Keep this length — the audio duration must stay the same.
- Weave in EVERY word from the study list naturally — the words may appear anywhere in any turn, in ANY grammatical form (inflected: -ing, -ed, plural, changed tense/number, or a common derived form). You need NOT keep the exact form given; prefer whatever form sounds natural. Do NOT force them awkwardly or list them.
- The dialogue is meant to be HEARD (text-to-speech), so keep sentences speakable.

(2) MULTIPLE-CHOICE questions — EXACTLY 5, ALL in ENGLISH, testing comprehension of MEANING:
- EACH has EXACTLY 4 options A/B/C/D, exactly one correct.
- CRITICAL — the correct answer and the options MUST NOT be the target study words themselves, and must NOT simply repeat wording from the transcript. Test whether the learner UNDERSTOOD the conversation (a speaker's intention, reason, feeling, a detail, a conclusion, what happens next), NOT whether they can spot a vocabulary word. A learner who only recognises the study words should NOT be able to guess the answer.
- PARAPHRASE like real IELTS: re-express ideas with synonyms and different grammar in both stem and options.
- Distractors MUST be tempting and easy to confuse (IELTS trap style): things that WERE mentioned but answer a different question, half-true statements, plausible numbers/names/reasons that were said about something else, or common misunderstandings of the audio. Avoid distractors that are obviously off-topic or absurd.
- Spread the 5 questions across the WHOLE dialogue (beginning, middle, end).
- For each: "vi" (Vietnamese translation of the question), "explain" (short Vietnamese explanation why the answer is correct), "evidence" (the exact transcript sentence that proves it).

(3) DICTATION — 5 to 6 short items:
- Each item is ONE sentence taken VERBATIM from the transcript, with 1-3 CONTENT words removed and shown as "____" (four underscores) in the "text".
- Prefer removing the TARGET study words (so the learner practises spelling them by ear); also remove other meaningful content words. Do NOT blank trivial words like "the", "a", "is".
- The removed words in "answers" MUST be the EXACT words AS THEY APPEAR in the transcript (keep their inflected form there, e.g. "tackled", "goals"), in the SAME ORDER as the "____" gaps, so they can be auto-graded. The learner spells back exactly what is heard — a study word blanked in an inflected form is graded in that form.
- Provide "vi": natural Vietnamese translation of the full (un-gapped) sentence.

Return ONLY valid JSON (no markdown, no preamble) with this exact shape:
{"title":"<short English scenario title>",
 "transcript":[{"speaker":"<name>","text":"<the spoken line, verbatim>","vi":"<natural Vietnamese translation>"}],
 "questions":[
   {"type":"mc","q":"<question>","options":["<A>","<B>","<C>","<D>"],"correct":<0-3>,"vi":"<dịch>","explain":"<giải thích tiếng Việt>","evidence":"<câu gốc trong transcript>"}
 ],
 "dictation":[
   {"text":"<a transcript sentence with ____ where words are removed>","answers":["<exact removed word 1>","<exact removed word 2>"],"vi":"<dịch cả câu>"}
 ]}
There MUST be exactly 5 objects in "questions" and 5-6 objects in "dictation". Output JSON only.`;

const SYS_DEFINE = `You are an English-Vietnamese dictionary for a Vietnamese learner who follows football/soccer news.
You receive ONE English word or short phrase. Explain it for the learner IN VIETNAMESE.
Return ONLY valid JSON (no markdown, no preamble) with this exact shape:
{"word":"<the word/phrase, lowercased>","ipa":"<IPA in slashes, e.g. /ˈmedɪkl/>","senses":[
  {"pos":"<từ loại tiếng Việt: danh từ / động từ / tính từ ...>","meaning_vi":"<nghĩa tiếng Việt, ngắn gọn, rõ>","example_en":"<one natural English example sentence>","example_vi":"<bản dịch tiếng Việt của câu ví dụ>"}
]}
Give 1-3 senses, most common first. If the word is common in football, add the football-specific sense.
ALWAYS include "ipa". Vietnamese must be fluent and natural. Output JSON only.`;

const SYS_RANK = `You are a personalisation engine for a MULTI-TOPIC X/Twitter news reader (topics can be football, technology, jobs/careers, world news, business/finance, science, etc.).
You receive:
(1) the user's INTEREST PROFILE — a set of TOPICS they care about, each with a weight (0..1; higher = more interested) and optional keywords; optionally also some accounts they follow and some free-text emerging interests.
(2) a list of CANDIDATE tweets from accounts the user does NOT follow.
For EACH candidate tweet return:
- "score" (integer 0-10): how likely THIS user wants to see it. A tweet strongly matching a HIGH-weight topic (or their keywords / emerging interests) scores high; a tweet on a low-weight or unlisted topic scores lower; spam, giveaways, promotions, engagement-bait, ads, or non-English noise score 0-3. Judge ONLY from the tweet's text and topic — do NOT reward a tweet just for being popular.
- "topic": classify the tweet into EXACTLY ONE of the user's topic LABELS given in the profile, or "khác" if it fits none of them. Use the labels verbatim.
Return ONLY valid JSON (no markdown, no preamble): {"scores":[{"id":"<the tweet id verbatim>","score":<0-10>,"topic":"<one given label or 'khác'>"}]}
Include EXACTLY one entry for every candidate tweet, using the SAME id given. Output JSON only.`;

const SYS_INTEREST = `You infer a user's TOPIC INTERESTS from what they spend time READING in a news feed.
You receive: (1) a list of TOPIC LABELS the user selected; (2) a sample of tweet texts the user spent time reading (dwelled on).
Return, for the SELECTED topics ONLY:
- "weights": an object mapping EACH selected label -> a number 0..1 reflecting how much of the user's reading matches that topic. Base it on the reading sample. They need NOT sum to 1. A topic with clearly more matching reading gets a higher value; a topic with little/no matching reading gets a low value (but keep it >0 unless truly absent).
- "keywords": an object mapping EACH selected label -> up to 6 short English keywords/phrases capturing what the user actually reads within that topic (draw from the sample when possible; [] if unknown).
- "emerging": up to 4 SHORT free-text interest tags that the reading reveals but that are NOT covered by any selected label (e.g. a specific club, company, or subject). May be [].
Return ONLY valid JSON (no markdown, no preamble): {"weights":{"<label>":0.0},"keywords":{"<label>":["..."]},"emerging":["..."]}
Use the selected labels VERBATIM as keys. Output JSON only.`;

const SYS_ENRICH = `You enrich a Vietnamese learner's saved English vocabulary. You receive a LIST of English words/phrases; each comes with the ONE meaning the learner already saved (the meaning they met it in).
For EACH item, return:
- "collocations": 2-4 common English collocations/phrases for THAT saved meaning, comma-separated (e.g. for "medical" meaning y tế: "medical examination, pass a medical, medical staff"). If it is a proper noun or has essentially no collocations, use "".
- "other_meanings": the word's OTHER common meanings that DIFFER from the saved meaning, ordered from MOST common to LEAST common. For EACH: "pos" (từ loại tiếng Việt: danh từ / động từ / tính từ ...), "meaning_vi" (a short, clear Vietnamese meaning), "collocations" (2-4 common English collocations for THAT sense, comma-separated). Include AT MOST 3. If the word genuinely has no other common meaning (proper noun, single-sense term), use [].
Do NOT repeat the saved meaning inside "other_meanings". Keep Vietnamese natural and concise.
Return ONLY valid JSON (no markdown, no preamble): {"items":[{"word":"<same word verbatim>","collocations":"<...>","other_meanings":[{"pos":"...","meaning_vi":"...","collocations":"..."}]}]}
The "items" array MUST have exactly one entry per input word, in the SAME order. Output JSON only.`;

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
    const provider = ALLOWED_PROVIDERS.includes(body.provider) ? body.provider : "gemini";   // mặc định gemini

    // ===== 1) KÉO TIN =====
    if (typeof body.source === "string") {
      const handle = body.source.trim();
      if (!/^[A-Za-z0-9_]{1,30}$/.test(handle)) return res.status(400).json({ error: "Tên kênh không hợp lệ." });
      const tw = await fetchSource(handle);
      if (tw.error) return res.status(502).json({ error: tw.error });
      return res.status(200).json({ tweets: tw.tweets });
    }

    // ===== 1b) DANH SÁCH ĐANG THEO DÕI (để dựng bảng tin như X) =====
    // body { followings: "handle", cursor?: "" } -> { users:[...], next_cursor, has_next_page }
    if (typeof body.followings === "string") {
      const handle = body.followings.trim().replace(/^@/, "");
      if (!/^[A-Za-z0-9_]{1,30}$/.test(handle)) return res.status(400).json({ error: "Tên tài khoản không hợp lệ." });
      const out = await fetchFollowings(handle, typeof body.cursor === "string" ? body.cursor : "");
      if (out.error) return res.status(502).json({ error: out.error });
      return res.status(200).json(out);
    }

    // ===== 1c) BẢNG TIN (trộn tweet của nhiều tài khoản, có phân trang để cuộn) =====
    // body { feed: { groups:[{handles:[...], cursor:""}], mode?: "search"|"user", win?: 24, rt?: true } }
    //   -> { tweets:[<tweet đầy đủ, sort mới->cũ>], groups:[{cursor, hasMore}] }
    if (body.feed && typeof body.feed === "object") {
      const out = await fetchFeed(body.feed);
      if (out.error) return res.status(502).json({ error: out.error });
      return res.status(200).json(out);
    }

    // ===== 1d) XẾP HẠNG TIN GỢI Ý (kênh chưa theo dõi) theo sở thích người dùng =====
    // body { rank: { profile:{topics:[{name,weight,keywords}], follows:[...], emerging:[...] }, tweets:[{id,text,author:{userName}}] }, provider }
    //   -> { scores:[{id,score,topic}] }
    if (body.rank && typeof body.rank === "object") {
      const r = body.rank;
      const tweets = (Array.isArray(r.tweets) ? r.tweets : []).filter(t => t && t.id != null).slice(0, 50);
      if (!tweets.length) return res.status(200).json({ scores: [] });
      const prof = r.profile || {};
      const topics = (Array.isArray(prof.topics) ? prof.topics : []).slice(0, 12);
      const follows = (Array.isArray(prof.follows) ? prof.follows : []).slice(0, 40);
      const emerging = (Array.isArray(prof.emerging) ? prof.emerging : []).slice(0, 8);
      const topicsMsg = topics.length
        ? "INTEREST TOPICS (label — weight — keywords):\n" + topics.map(t => {
            const w = Number(t.weight); const kw = Array.isArray(t.keywords) ? t.keywords.slice(0, 8).join(", ") : "";
            return `- ${t.name} — ${isNaN(w) ? "?" : w.toFixed(2)}${kw ? " — " + kw : ""}`;
          }).join("\n")
        : "";
      const followsMsg = follows.length ? "Also follows: " + follows.map(f => String(f).slice(0, 100)).join("; ") : "";
      const emergingMsg = emerging.length ? "Emerging interests: " + emerging.map(String).join(", ") : "";
      const profileMsg = [topicsMsg, followsMsg, emergingMsg].filter(Boolean).join("\n\n")
        || "The user reads general news (football, technology, world news).";
      const tweetsMsg = tweets.map(t =>
        `[${t.id}] @${(t.author && t.author.userName) || "?"}: ${String(t.text || "").replace(/\s+/g, " ").slice(0, 240)}`
      ).join("\n");
      const out = await callLLM(provider, SYS_RANK,
        profileMsg + "\n\nScore (0-10) and tag the topic of each candidate tweet for this user.\nCANDIDATE TWEETS:\n" + tweetsMsg,
        3000);
      if (out.error) return res.status(502).json({ error: out.error });
      const scores = Array.isArray(out.json && out.json.scores) ? out.json.scores : [];
      return res.status(200).json({ scores });
    }

    // ===== 1e) HỒ SƠ SỞ THÍCH (suy ra trọng số chủ đề từ tin user ĐỌC LÂU) =====
    // body { interest: { topics:[label...], reads:[text...] }, provider } -> { weights:{label:0..1}, keywords:{label:[...]}, emerging:[...] }
    if (body.interest && typeof body.interest === "object") {
      const it = body.interest;
      const labels = (Array.isArray(it.topics) ? it.topics : []).map(String).map(s => s.slice(0, 60)).slice(0, 12);
      if (!labels.length) return res.status(400).json({ error: "Thiếu danh sách chủ đề." });
      const reads = (Array.isArray(it.reads) ? it.reads : []).slice(0, 120)
        .map(s => String(s || "").replace(/\s+/g, " ").slice(0, 180)).filter(Boolean);
      const msg = "SELECTED TOPICS:\n" + labels.map(l => "- " + l).join("\n")
        + "\n\nTWEETS THE USER SPENT TIME READING:\n"
        + (reads.length ? reads.map((t, i) => `${i + 1}. ${t}`).join("\n") : "(none yet)");
      const out = await callLLM(provider, SYS_INTEREST, msg, 1500);
      if (out.error) return res.status(502).json({ error: out.error });
      const j = out.json || {};
      return res.status(200).json({
        weights: (j.weights && typeof j.weights === "object") ? j.weights : {},
        keywords: (j.keywords && typeof j.keywords === "object") ? j.keywords : {},
        emerging: Array.isArray(j.emerging) ? j.emerging : [],
      });
    }

    // ===== 4) TRA TỪ ĐIỂN (nghĩa tiếng Việt + ví dụ) =====
    if (typeof body.define === "string") {
      const word = body.define.trim().slice(0, 80);
      if (!word) return res.status(400).json({ error: "Thiếu từ cần tra." });
      const out = await callLLM(provider, SYS_DEFINE, "WORD: " + word, 1200);
      if (out.error) return res.status(502).json({ error: out.error });
      const j = out.json || {};
      return res.status(200).json({
        word: typeof j.word === "string" ? j.word : word,
        ipa: typeof j.ipa === "string" ? j.ipa : "",
        senses: Array.isArray(j.senses) ? j.senses : [],
      });
    }

    // ===== 3) TẠO ĐỀ =====
    if (Array.isArray(body.quiz)) {
      if (!body.quiz.length) return res.status(400).json({ error: "Danh sách từ vựng rỗng." });
      const wordList = body.quiz.map((v, i) => `${i + 1}. ${fmtQuizWord(v)}`).join("\n");
      let quizMsg = "Study list:\n" + wordList;
      // Từ "nhắc lại" (lấy từ tab Đã ôn) — lồng vào câu hỏi/đáp án, KHÔNG ra câu hỏi riêng cho chúng.
      const remind = Array.isArray(body.remind) ? body.remind.filter(v => v && v.word) : [];
      if (remind.length) {
        const remindList = remind.map((v, i) => `${i + 1}. ${fmtQuizWord(v)}`).join("\n");
        quizMsg += "\n\nReview list (weave these in as reminders / distractors; do NOT dedicate questions to them):\n" + remindList;
      }
      const out = await callLLM(provider, SYS_QUIZ, quizMsg, 10000);
      if (out.error) return res.status(502).json({ error: out.error });
      const questions = (Array.isArray(out.json.questions) ? out.json.questions : []).filter(validQuizQuestion);
      if (!questions.length) return res.status(502).json({ error: "Model trả về đề không hợp lệ. Thử lại." });
      return res.status(200).json({ questions });
    }

    // ===== 3b) BỔ SUNG NGHĨA KHÁC + COLLOCATION cho từ đã lưu =====
    if (Array.isArray(body.enrich)) {
      if (!body.enrich.length) return res.status(400).json({ error: "Danh sách từ rỗng." });
      if (body.enrich.length > 20) return res.status(400).json({ error: "Tối đa 20 từ mỗi lần." });
      const list = body.enrich
        .map((v, i) => `${i + 1}. ${v.word}${v.meaning_vi ? " — saved meaning: " + v.meaning_vi : ""}`)
        .join("\n");
      const out = await callLLM(provider, SYS_ENRICH, "Words:\n" + list, 8000);
      if (out.error) return res.status(502).json({ error: out.error });
      return res.status(200).json({ items: Array.isArray(out.json.items) ? out.json.items : [] });
    }

    // ===== 5) LUYỆN NGHE (tạo hội thoại + câu hỏi kiểu IELTS) =====
    if (Array.isArray(body.listen)) {
      if (!body.listen.length) return res.status(400).json({ error: "Danh sách từ vựng rỗng." });
      const wordList = body.listen
        .map((v, i) => `${i + 1}. ${v.word}${v.meaning_vi ? " — meaning: " + v.meaning_vi : ""}`)
        .join("\n");
      const out = await callLLM(provider, SYS_LISTEN, "Study words:\n" + wordList, 8000);
      if (out.error) return res.status(502).json({ error: out.error });
      const j = out.json || {};
      return res.status(200).json({
        title: typeof j.title === "string" ? j.title : "",
        transcript: Array.isArray(j.transcript) ? j.transcript : [],
        questions: Array.isArray(j.questions) ? j.questions : [],
        dictation: Array.isArray(j.dictation) ? j.dictation : [],
      });
    }

    // ===== 6) TTS LUYỆN NGHE (đọc hội thoại thành tiếng — audio thật để tua được) =====
    if (Array.isArray(body.tts)) {
      if (!body.tts.length) return res.status(400).json({ error: "Thiếu lời thoại để đọc." });
      const total = body.tts.reduce((n, t) => n + (t && typeof t.text === "string" ? t.text.length : 0), 0);
      if (!total) return res.status(400).json({ error: "Lời thoại rỗng." });
      if (total > 3500) return res.status(400).json({ error: "Đoạn hội thoại quá dài để tạo audio." });
      const out = await callGeminiTTS(body.tts);
      if (out.error) return res.status(502).json({ error: out.error });
      return res.status(200).json({ audio: out.audio, mime: out.mime });
    }

    // ===== 2) DỊCH =====
    let tweets = body.tweets;
    if (!Array.isArray(tweets)) {
      const single = body.text;
      tweets = (single && typeof single === "string") ? [single] : null;
    }
    if (!tweets || !tweets.length) return res.status(400).json({ error: "Thiếu 'source', 'tweets', 'quiz', 'enrich'..." });
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
  if (provider === "groq") return callGroq(system, user, maxTokens);
  if (CLAUDE_MODELS[provider]) return callAnthropic(system, user, maxTokens, CLAUDE_MODELS[provider]);
  if (provider === "gemini-free") {
    const k = process.env.GEMINI_FREE_API_KEY;
    if (!k) return { error: "Chưa đặt GEMINI_FREE_API_KEY trên Vercel." };
    return callGemini(system, user, maxTokens, k);
  }
  // "gemini" mặc định = key trả phí
  if (!process.env.GEMINI_API_KEY) return { error: "Chưa đặt GEMINI_API_KEY trên Vercel." };
  return callGemini(system, user, maxTokens, process.env.GEMINI_API_KEY);
}

// Tách JSON từ text trả về (Claude không có chế độ JSON cứng như Groq/Gemini).
function extractJson(raw) {
  const s = (raw || "").replace(/```json|```/g, "").trim();
  try { return JSON.parse(s); } catch {}
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a >= 0 && b > a) { try { return JSON.parse(s.slice(a, b + 1)); } catch {} }
  return null;
}

async function callAnthropic(system, user, maxTokens, model) {
  if (!process.env.ANTHROPIC_API_KEY) return { error: "Chưa đặt ANTHROPIC_API_KEY trên Vercel." };
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: Math.min(maxTokens, 8192),
      temperature: 0.4,
      system,
      messages: [{ role: "user", content: user }],
    }),
  });
  if (!r.ok) { const d = await r.text(); return { error: "Claude " + r.status + ": " + d.slice(0, 400) }; }
  const data = await r.json();
  const raw = (data.content || []).filter((b) => b.type === "text").map((b) => b.text || "").join("\n");
  const j = extractJson(raw);
  return j ? { json: j } : { error: "Không phân tích được JSON từ Claude" };
}

async function callGemini(system, user, maxTokens, apiKey) {
  const url = "https://generativelanguage.googleapis.com/v1beta/models/" + GEMINI_MODEL + ":generateContent";
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey || process.env.GEMINI_API_KEY },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts: [{ text: user }] }],
      generationConfig: {
        responseMimeType: "application/json",
        maxOutputTokens: maxTokens,
        temperature: 0.4,
        // gemini-2.5-flash là "thinking model": mặc định ngốn output token để suy nghĩ
        // trước khi in JSON -> dễ chạm MAX_TOKENS, JSON bị cắt cụt -> parse lỗi.
        // Tắt thinking để dồn toàn bộ token cho JSON (nhanh + rẻ hơn).
        thinkingConfig: { thinkingBudget: 0 },
      },
    }),
  });
  if (!r.ok) { const d = await r.text(); return { error: "Gemini " + r.status + ": " + d.slice(0, 400) }; }
  const data = await r.json();
  const cand = data.candidates?.[0];
  const raw = (cand?.content?.parts || []).map((p) => p.text || "").join("\n").replace(/```json|```/g, "").trim();
  try {
    return { json: JSON.parse(raw) };
  } catch {
    const reason = cand?.finishReason || "?";
    const hint = reason === "MAX_TOKENS" ? " (output bị cắt vì hết token — thử lại hoặc giảm số từ)" : "";
    return { error: "Không phân tích được JSON từ Gemini [" + reason + "]" + hint };
  }
}

// Đọc hội thoại thành tiếng bằng Gemini TTS. Trả base64 PCM 16-bit (mime kèm sample rate).
// Đa giọng: gán 2 speaker đầu tiên vào 2 giọng khác nhau (Gemini multi-speaker tối đa 2 người).
async function callGeminiTTS(turns) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return { error: "Chưa đặt GEMINI_API_KEY trên Vercel." };
  const speakers = [];
  for (const t of turns) { const s = (t && t.speaker || "").trim(); if (s && !speakers.includes(s)) speakers.push(s); }
  const text = "TTS the following conversation. Read each line naturally in a spoken style:\n"
    + turns.map((t) => `${(t && t.speaker || "Speaker").trim()}: ${(t && t.text || "").trim()}`).join("\n");
  let speechConfig;
  if (speakers.length >= 2) {
    speechConfig = { multiSpeakerVoiceConfig: { speakerVoiceConfigs: speakers.slice(0, 2).map((s, i) => ({
      speaker: s, voiceConfig: { prebuiltVoiceConfig: { voiceName: TTS_VOICES[i] || TTS_VOICES[0] } } })) } };
  } else {
    speechConfig = { voiceConfig: { prebuiltVoiceConfig: { voiceName: TTS_VOICES[0] } } };
  }
  const url = "https://generativelanguage.googleapis.com/v1beta/models/" + TTS_MODEL + ":generateContent";
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text }] }],
      generationConfig: { responseModalities: ["AUDIO"], speechConfig },
    }),
  });
  if (!r.ok) { const d = await r.text(); return { error: "Gemini TTS " + r.status + ": " + d.slice(0, 400) }; }
  const data = await r.json();
  const part = (data.candidates?.[0]?.content?.parts || []).find((p) => p.inlineData?.data);
  if (!part) return { error: "Gemini TTS không trả audio" };
  return { audio: part.inlineData.data, mime: part.inlineData.mimeType || "audio/L16;codec=pcm;rate=24000" };
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
    tweets.push({ text, created_at: created, ts: isNaN(t) ? null : t });   // ts: mốc thời gian (ms) để frontend lọc 6/12/24h
  }
  return { tweets };
}

// ===================== BẢNG TIN KIỂU X =====================
// Không có API nào cho phép đọc feed "For You" thật (X không mở, twitterapi.io cũng không có).
// Ta dựng lại tab "Đang theo dõi": lấy danh sách following (công khai) rồi trộn tweet của họ theo thời gian.

const TAPI = "https://api.twitterapi.io/twitter";

async function tapi(path, params) {
  const key = process.env.TWITTERAPI_KEY;
  if (!key) return { error: "Chưa đặt TWITTERAPI_KEY trên Vercel." };
  const qs = new URLSearchParams(params).toString();
  const r = await fetch(TAPI + path + (qs ? "?" + qs : ""), { headers: { "x-api-key": key } });
  if (!r.ok) { const d = await r.text(); return { error: "twitterapi " + r.status + ": " + d.slice(0, 300) }; }
  const j = await r.json();
  if (j && j.error && j.code !== 0) return { error: "twitterapi: " + (j.message || j.error) };
  return { json: j };
}

// Danh sách tài khoản mà "handle" đang theo dõi (công khai — không cần đăng nhập).
async function fetchFollowings(handle, cursor) {
  const out = await tapi("/user/followings", { userName: handle, pageSize: 200, cursor: cursor || "" });
  if (out.error) return { error: out.error };
  const j = out.json || {};
  const raw = j.followings || j.users || j?.data?.followings || [];
  const users = raw.map(u => ({
    userName: u.userName || u.screen_name || "",
    name: u.name || "",
    avatar: (u.profilePicture || u.profile_image_url_https || "").replace("_normal.", "_x96."),
    description: (u.description || "").slice(0, 160),
    followers: u.followers || u.followers_count || 0,
    verified: !!(u.isBlueVerified || u.verified),
  })).filter(u => u.userName);
  return { users, next_cursor: j.next_cursor || "", has_next_page: !!j.has_next_page };
}

// Ảnh/video kèm theo tweet (API trả ở extendedEntities, đôi khi ở entities).
function mediaOf(tw) {
  const arr = tw?.extendedEntities?.media || tw?.extended_entities?.media || tw?.entities?.media || [];
  const out = [];
  for (const m of arr) {
    const type = m.type === "animated_gif" ? "gif" : (m.type || "photo");
    if (type === "video" || type === "gif") {
      const vars = (m.video_info?.variants || []).filter(v => v.content_type === "video/mp4");
      vars.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
      out.push({ type, url: vars[0]?.url || "", poster: m.media_url_https || m.media_url || "" });
    } else {
      out.push({ type: "photo", url: m.media_url_https || m.media_url || "", poster: "" });
    }
  }
  return out.filter(m => m.url || m.poster);
}

function authorOf(tw) {
  const a = tw?.author || {};
  return {
    userName: a.userName || a.screen_name || "",
    name: a.name || "",
    avatar: (a.profilePicture || a.profile_image_url_https || "").replace("_normal.", "_x96."),
    verified: !!(a.isBlueVerified || a.verified),
  };
}

function cleanText(s) {
  return String(s || "").replace(/https:\/\/t\.co\/\w+/g, "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

// Chuẩn hóa 1 tweet cho bảng tin. Retweet: lấy NỘI DUNG của tweet gốc, ghi nhận ai đã đăng lại (rtBy).
function normTweet(tw) {
  if (!tw) return null;
  const isRT = !!tw.retweeted_tweet;
  const rtBy = isRT ? authorOf(tw) : null;
  const core = isRT ? tw.retweeted_tweet : tw;
  const t = Date.parse(core.createdAt || core.created_at || tw.createdAt || "");
  const text = cleanText(core.text || core.full_text || "");
  const q = core.quoted_tweet;
  if (!text && !mediaOf(core).length) return null;
  return {
    id: core.id || tw.id || "",
    url: core.url || (core.author?.userName && core.id ? `https://x.com/${core.author.userName}/status/${core.id}` : ""),
    text,
    ts: isNaN(t) ? null : t,
    author: authorOf(core),
    rtBy,                                   // null nếu không phải retweet
    media: mediaOf(core),
    likes: core.likeCount || 0,
    retweets: core.retweetCount || 0,
    replies: core.replyCount || 0,
    views: core.viewCount || 0,
    quote: q ? { author: authorOf(q), text: cleanText(q.text || q.full_text || ""), media: mediaOf(q) } : null,
  };
}

function tweetsOf(j) {
  return j?.tweets || j?.data?.tweets || j?.data || [];
}

// Một "nhóm" = tối đa ~20 handle gộp trong 1 truy vấn tìm kiếm (X giới hạn độ dài query).
// mode "search": 1 lần gọi trả 20 tweet ĐÃ TRỘN của cả nhóm -> rẻ, hợp với cuộn tải thêm.
// mode "user":   mỗi handle 1 lần gọi (chắc chắn có retweet) -> tốn credit hơn.
async function fetchGroup(group, mode, sinceTs, withRT) {
  const handles = (group.handles || []).filter(h => /^[A-Za-z0-9_]{1,30}$/.test(h)).slice(0, 25);
  if (!handles.length) return { tweets: [], cursor: "", hasMore: false };

  if (mode === "user") {
    const cursors = group.cursors || {};
    const results = await Promise.all(handles.map(async h => {
      const out = await tapi("/user/last_tweets", { userName: h, cursor: cursors[h] || "" });
      if (out.error) return { h, tweets: [], cursor: "", hasMore: false };
      const j = out.json || {};
      return { h, tweets: tweetsOf(j), cursor: j.next_cursor || "", hasMore: !!j.has_next_page };
    }));
    const tweets = [];
    const nextCursors = {};
    let hasMore = false;
    for (const r of results) {
      nextCursors[r.h] = r.cursor;
      if (r.hasMore) hasMore = true;
      for (const tw of r.tweets) {
        if (tw.isReply || tw.inReplyToId) continue;
        const n = normTweet(tw);
        if (n && (!sinceTs || !n.ts || n.ts >= sinceTs)) tweets.push(n);
      }
    }
    return { tweets, cursors: nextCursors, hasMore };
  }

  const q = "(" + handles.map(h => "from:" + h).join(" OR ") + ") -filter:replies"
          + (withRT ? " include:nativeretweets" : "")
          + (sinceTs ? " since_time:" + Math.floor(sinceTs / 1000) : "");
  const out = await tapi("/tweet/advanced_search", { query: q, queryType: "Latest", cursor: group.cursor || "" });
  if (out.error) return { tweets: [], cursor: "", hasMore: false, error: out.error };
  const j = out.json || {};
  const tweets = [];
  for (const tw of tweetsOf(j)) {
    if (tw.isReply || tw.inReplyToId) continue;
    const n = normTweet(tw);
    if (n) tweets.push(n);
  }
  return { tweets, cursor: j.next_cursor || "", hasMore: !!j.has_next_page };
}

// Bảng tin: gọi song song từng nhóm, trộn tất cả rồi sắp mới -> cũ.
async function fetchFeed(feed) {
  const key = process.env.TWITTERAPI_KEY;
  if (!key) return { error: "Chưa đặt TWITTERAPI_KEY trên Vercel." };
  const groups = Array.isArray(feed.groups) ? feed.groups.slice(0, 16) : [];   // 16 nhóm × 15 handle = 240 tài khoản
  if (!groups.length) return { error: "Chưa chọn tài khoản nào cho bảng tin." };
  const mode = feed.mode === "user" ? "user" : "search";
  const withRT = feed.rt !== false;
  const win = Math.min(Math.max(Number(feed.win) || 24, 1), 168);
  const sinceTs = Date.now() - win * 3600 * 1000;

  const results = await Promise.all(groups.map(g => fetchGroup(g, mode, sinceTs, withRT)));
  const err = results.find(r => r.error);
  if (err && results.every(r => !r.tweets.length)) return { error: err.error };

  const seen = new Set();
  const tweets = [];
  for (const r of results) {
    for (const tw of r.tweets) {
      if (tw.id && seen.has(tw.id)) continue;
      if (tw.id) seen.add(tw.id);
      tweets.push(tw);
    }
  }
  tweets.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  return {
    tweets,
    groups: results.map(r => ({ cursor: r.cursor || "", cursors: r.cursors || null, hasMore: !!r.hasMore })),
  };
}
