require('dotenv').config();
const express = require('express');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
const PORT = process.env.PORT || 3000;

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// Determine if we're running on Vercel (no local filesystem access)
const IS_VERCEL = !!process.env.VERCEL;

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── BOTS ───────────────────────────────────────────────────────────────────

app.get('/api/bots', async (req, res) => {
  try {
    const { data: bots, error } = await supabase.from('bots').select('*').order('created_at', { ascending: true });
    if (error) return res.status(500).json({ error: error.message });

    const botsWithCounts = await Promise.all(bots.map(async (bot) => {
      const { count } = await supabase
        .from('knowledge_chunks')
        .select('id', { count: 'exact', head: true })
        .eq('bot_id', bot.id);

      let pdfCount = 0;
      if (!IS_VERCEL) {
        const fs = require('fs');
        const pdfDir = path.join(process.env.HOME || '/root', 'thrive-bot', 'pdfs');
        pdfCount = fs.existsSync(pdfDir)
          ? fs.readdirSync(pdfDir).filter(f => f.toLowerCase().endsWith('.pdf')).length
          : 0;
      }

      return { ...bot, chunkCount: count || 0, pdfCount };
    }));

    res.json(botsWithCounts);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/bots', async (req, res) => {
  try {
    const { name, description } = req.body;
    const id = name.toLowerCase().replace(/[^a-z0-9]/g, '-');
    const { error } = await supabase.from('bots').insert({ id, name, description, status: 'active' });
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true, id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── PDFs (local only — not available on Vercel) ─────────────────────────────

app.get('/api/bots/:botId/pdfs', (req, res) => {
  if (IS_VERCEL) return res.json([]);
  const fs = require('fs');
  const pdfDir = path.join(process.env.HOME || '/root', 'thrive-bot', 'pdfs');
  if (!fs.existsSync(pdfDir)) return res.json([]);
  const files = fs.readdirSync(pdfDir)
    .filter(f => f.toLowerCase().endsWith('.pdf'))
    .map(f => {
      const stats = fs.statSync(path.join(pdfDir, f));
      return { name: f, size: stats.size, modified: stats.mtime };
    });
  res.json(files);
});

app.post('/api/bots/:botId/pdfs', (req, res) => {
  if (IS_VERCEL) return res.status(400).json({ error: 'PDF upload must be done from your local dashboard.' });
  const multer = require('multer');
  const fs = require('fs');
  const pdfDir = path.join(process.env.HOME || '/root', 'thrive-bot', 'pdfs');
  if (!fs.existsSync(pdfDir)) fs.mkdirSync(pdfDir, { recursive: true });
  const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, pdfDir),
    filename: (req, file, cb) => cb(null, file.originalname),
  });
  const upload = multer({ storage, fileFilter: (req, file, cb) => cb(null, file.mimetype === 'application/pdf') });
  upload.array('pdfs')(req, res, (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true, uploaded: req.files.length });
  });
});

app.delete('/api/bots/:botId/pdfs/:filename', (req, res) => {
  if (IS_VERCEL) return res.status(400).json({ error: 'File deletion must be done from your local dashboard.' });
  const fs = require('fs');
  const pdfPath = path.join(process.env.HOME || '/root', 'thrive-bot', 'pdfs', req.params.filename);
  if (fs.existsSync(pdfPath)) fs.unlinkSync(pdfPath);
  res.json({ success: true });
});

app.post('/api/bots/:botId/rebuild', (req, res) => {
  if (IS_VERCEL) return res.status(400).json({ error: 'Knowledge base rebuild must be run locally: node ~/thrive-bot/build-kb.js' });
  const { exec } = require('child_process');
  res.json({ success: true, message: 'Rebuilding started...' });
  exec((process.env.HOME || '/root') + '/thrive-bot && node build-kb.js', (err, stdout, stderr) => {
    console.log('Rebuild:', stdout);
    if (err) console.error('Rebuild error:', stderr);
  });
});

// ─── STATUS ──────────────────────────────────────────────────────────────────

app.get('/api/bots/:botId/status', async (req, res) => {
  try {
    const { count, error } = await supabase
      .from('knowledge_chunks')
      .select('id', { count: 'exact', head: true })
      .eq('bot_id', req.params.botId);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ chunks: count || 0 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── TEST ────────────────────────────────────────────────────────────────────

app.post('/api/bots/:botId/test', async (req, res) => {
  try {
    const { question } = req.body;
    const { data: knowledge, error } = await supabase
      .from('knowledge_chunks')
      .select('source, text, chunk_index')
      .eq('bot_id', req.params.botId);

    if (error) return res.status(500).json({ error: error.message });
    if (!knowledge || knowledge.length === 0) return res.json({ error: 'No knowledge base built yet.' });

    const words = question.toLowerCase().split(/\s+/).filter(w => w.length > 2);
    const scored = knowledge.map(chunk => {
      const text = chunk.text.toLowerCase();
      let score = 0;
      for (const word of words) {
        const count = (text.match(new RegExp(word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
        score += count;
      }
      return { ...chunk, score };
    }).sort((a, b) => b.score - a.score).slice(0, 5).filter(c => c.score > 0);

    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const context = scored.length > 0
      ? scored.map((c, i) => `--- EXCERPT ${i+1} FROM: ${c.source} ---\n${c.text}`).join('\n\n')
      : null;
    const system = context
      ? `You are the Thrive Acquisition assistant. Answer using ONLY the programme content below.\n\n=== PROGRAMME CONTENT ===\n\n${context}\n\n=== END ===`
      : 'No specific content found. Tell the user this topic is not in the materials.';

    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      system,
      messages: [{ role: 'user', content: question }],
    });
    res.json({ answer: response.content[0].text, chunks: scored, question });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── QUESTIONS LOG ───────────────────────────────────────────────────────────

app.get('/api/bots/:botId/questions', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('questions_log')
      .select('*')
      .eq('bot_id', req.params.botId)
      .order('created_at', { ascending: false })
      .limit(50);
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── AXEL INTEGRATION ────────────────────────────────────────────────────────

// ---- KNOWLEDGE BASE ----
app.get('/api/axel/kb', async (req, res) => {
  try {
    const { category, search } = req.query;
    let q = supabase.from('knowledge_base').select('id, title, category, content, tags, updated_at').order('updated_at', { ascending: false });
    if (category && category !== 'all') q = q.eq('category', category);
    const { data, error } = await q;
    if (error) return res.status(500).json({ error: error.message });
    let rows = data || [];
    if (search) {
      const s = search.toLowerCase();
      rows = rows.filter(r => (r.title||'').toLowerCase().includes(s) || (r.content||'').toLowerCase().includes(s));
    }
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/axel/kb/categories', async (req, res) => {
  try {
    const { data, error } = await supabase.from('knowledge_base').select('category');
    if (error) return res.status(500).json({ error: error.message });
    const counts = {};
    (data || []).forEach(r => { counts[r.category] = (counts[r.category] || 0) + 1; });
    res.json(counts);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/axel/kb/:id', async (req, res) => {
  try {
    const { data, error } = await supabase.from('knowledge_base').select('*').eq('id', req.params.id).single();
    if (error) return res.status(404).json({ error: error.message });
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---- CALLS ----
app.get('/api/axel/calls', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('call_analyses')
      .select('id, call_id, call_date, prospect_name, duration_mins, pillar_scores, what_worked, what_stalled, key_objections, coaching_note, outcome, created_at')
      .order('call_date', { ascending: false })
      .limit(100);
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/axel/calls/:id', async (req, res) => {
  try {
    const { data, error } = await supabase.from('call_analyses').select('*').eq('id', req.params.id).single();
    if (error) return res.status(404).json({ error: error.message });
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---- BRIEFINGS ----
app.get('/api/axel/briefings', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('daily_briefings')
      .select('id, briefing, brief_date, delivered, created_at')
      .order('brief_date', { ascending: false })
      .limit(60);
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---- ESCALATIONS HISTORY ----
app.get('/api/axel/escalations/all', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('escalations')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(80);
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---- CONVERSATIONS (Alex ↔ Axel) ----
app.get('/api/axel/conversations', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('conversations')
      .select('id, role, content, created_at')
      .order('created_at', { ascending: false })
      .limit(200);
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---- SETTERS ----
app.get('/api/axel/setters', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('setter_performance')
      .select('*')
      .order('report_date', { ascending: false })
      .limit(60);
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---- AXEL MEMORY (KV) ----
app.get('/api/axel/memory', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('axel_kv')
      .select('key, value, category, updated_at')
      .order('updated_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---- SYSTEM HEALTH ----
app.get('/api/axel/health', async (req, res) => {
  try {
    const [briefRes, callRes, kpiRes, escRes, convRes] = await Promise.all([
      supabase.from('daily_briefings').select('brief_date, delivered, created_at').order('created_at', { ascending: false }).limit(1).maybeSingle(),
      supabase.from('call_analyses').select('created_at').order('created_at', { ascending: false }).limit(1).maybeSingle(),
      supabase.from('kpis').select('updated_at').order('updated_at', { ascending: false }).limit(1).maybeSingle(),
      supabase.from('escalations').select('id', { count: 'exact', head: true }).eq('status', 'pending'),
      supabase.from('conversations').select('id', { count: 'exact', head: true }).gte('created_at', new Date(Date.now() - 24*60*60*1000).toISOString()),
    ]);
    res.json({
      lastBriefing: briefRes?.data || null,
      lastCallAnalysis: callRes?.data?.created_at || null,
      lastKpiSync: kpiRes?.data?.updated_at || null,
      pendingEscalations: escRes?.count || 0,
      conversationsToday: convRes?.count || 0,
      checkedAt: new Date().toISOString(),
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/axel/kpis', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('kpis')
      .select('metric, value, period, period_date, notes')
      .order('period_date', { ascending: false })
      .limit(80);
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/axel/escalations', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('escalations')
      .select('id, title, context, urgency, created_at')
      .eq('status', 'pending')
      .order('created_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/axel/briefing', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('daily_briefings')
      .select('briefing, brief_date, delivered')
      .order('brief_date', { ascending: false })
      .limit(1)
      .single();
    if (error) return res.status(404).json({ error: error.message });
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/axel/feed', async (req, res) => {
  try {
    const [escResult, callResult, briefResult, convResult] = await Promise.all([
      supabase.from('escalations').select('title, urgency, created_at').order('created_at', { ascending: false }).limit(5),
      supabase.from('call_analyses').select('call_title, sentiment, call_date').order('call_date', { ascending: false }).limit(5),
      supabase.from('daily_briefings').select('brief_date, delivered, created_at').order('created_at', { ascending: false }).limit(3),
      supabase.from('kpis').select('metric, value, period_date, updated_at').order('updated_at', { ascending: false }).limit(3),
    ]);
    const feed = [];
    for (const e of (escResult.data || [])) {
      feed.push({ who: 'AXEL', body: `escalation raised · <b>${e.title}</b> · ${e.urgency}`, cls: e.urgency === 'critical' ? 'red' : '', ts: e.created_at });
    }
    for (const c of (callResult.data || [])) {
      feed.push({ who: 'AXEL', body: `call analysed · <b>${c.call_title || 'Discovery call'}</b> · ${c.sentiment || 'reviewed'}`, cls: 'green', ts: c.call_date });
    }
    for (const b of (briefResult.data || [])) {
      feed.push({ who: 'AXEL', body: `morning briefing ${b.delivered ? 'delivered' : 'generated'} · <b>${b.brief_date}</b>`, cls: 'info', ts: b.created_at });
    }
    for (const k of (convResult.data || [])) {
      feed.push({ who: 'SYSTEM', body: `KPI synced · <b>${k.metric.replace(/_/g,' ')}</b> → ${k.value}`, cls: '', ts: k.updated_at });
    }
    feed.sort((a, b) => new Date(b.ts) - new Date(a.ts));
    res.json(feed.slice(0, 12));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.listen(PORT, () => console.log(`Dashboard running at http://localhost:${PORT}`));

module.exports = app;
