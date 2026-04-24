require('dotenv').config();
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');
const { createClient } = require('@supabase/supabase-js');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
const PORT = process.env.PORT || 3000;

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// Middleware
app.use(express.json());
app.use(express.static('public'));

// PDF storage — always local in ~/thrive-bot/pdfs (per bot would need its own folder; using bot id as subfolder)
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const botId = req.params.botId;
    const pdfDir = path.join(process.env.HOME || '/root', 'thrive-bot', 'pdfs');
    if (!fs.existsSync(pdfDir)) fs.mkdirSync(pdfDir, { recursive: true });
    cb(null, pdfDir);
  },
  filename: (req, file, cb) => cb(null, file.originalname),
});
const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    cb(null, file.mimetype === 'application/pdf');
  },
});

// ─── BOTS ───────────────────────────────────────────────────────────────────

// GET all bots (from Supabase bots table, with live chunk counts)
app.get('/api/bots', async (req, res) => {
  try {
    const { data: bots, error } = await supabase.from('bots').select('*').order('created_at', { ascending: true });
    if (error) return res.status(500).json({ error: error.message });

    // For each bot, get chunk count from knowledge_chunks
    const botsWithCounts = await Promise.all(bots.map(async (bot) => {
      const { count } = await supabase
        .from('knowledge_chunks')
        .select('id', { count: 'exact', head: true })
        .eq('bot_id', bot.id);

      // PDF count from local folder
      const pdfDir = path.join(process.env.HOME || '/root', 'thrive-bot', 'pdfs');
      const pdfCount = fs.existsSync(pdfDir)
        ? fs.readdirSync(pdfDir).filter(f => f.toLowerCase().endsWith('.pdf')).length
        : 0;

      return { ...bot, chunkCount: count || 0, pdfCount };
    }));

    res.json(botsWithCounts);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST create new bot
app.post('/api/bots', async (req, res) => {
  try {
    const { name, description } = req.body;
    const id = name.toLowerCase().replace(/[^a-z0-9]/g, '-');
    const { error } = await supabase.from('bots').insert({
      id,
      name,
      description,
      status: 'active',
    });
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true, id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── PDFs (stays local) ──────────────────────────────────────────────────────

// GET PDFs for a bot
app.get('/api/bots/:botId/pdfs', (req, res) => {
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

// POST upload PDFs
app.post('/api/bots/:botId/pdfs', upload.array('pdfs'), (req, res) => {
  res.json({ success: true, uploaded: req.files.length });
});

// DELETE a PDF
app.delete('/api/bots/:botId/pdfs/:filename', (req, res) => {
  const pdfPath = path.join(process.env.HOME || '/root', 'thrive-bot', 'pdfs', req.params.filename);
  if (fs.existsSync(pdfPath)) fs.unlinkSync(pdfPath);
  res.json({ success: true });
});

// ─── KNOWLEDGE BASE ──────────────────────────────────────────────────────────

// POST rebuild knowledge base (runs build-kb.js which writes to Supabase)
app.post('/api/bots/:botId/rebuild', (req, res) => {
  res.json({ success: true, message: 'Rebuilding started — this may take a minute.' });
  exec('cd ' + (process.env.HOME || '/root') + '/thrive-bot && node build-kb.js', (err, stdout, stderr) => {
    console.log('Rebuild complete:', stdout);
    if (err) console.error('Rebuild error:', stderr);
  });
});

// GET knowledge base status (chunk count from Supabase)
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

// POST test a question against a bot's knowledge base
app.post('/api/bots/:botId/test', async (req, res) => {
  try {
    const { question } = req.body;
    const botId = req.params.botId;

    // Load chunks from Supabase
    const { data: knowledge, error } = await supabase
      .from('knowledge_chunks')
      .select('source, text, chunk_index')
      .eq('bot_id', botId);

    if (error) return res.status(500).json({ error: error.message });
    if (!knowledge || knowledge.length === 0) {
      return res.json({ error: 'No knowledge base built yet for this bot.' });
    }

    // Keyword search in memory
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
      ? `You are the Thrive Acquisition assistant. Answer using ONLY the programme content below. Be specific and direct.\n\n=== PROGRAMME CONTENT ===\n\n${context}\n\n=== END ===`
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

// GET recent questions for a bot (from Supabase questions_log)
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

app.listen(PORT, () => console.log(`Dashboard running at http://localhost:${PORT}`));
