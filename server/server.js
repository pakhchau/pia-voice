const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const jobHistory = require('./job-history');

// Track running job processes for abort capability
const runningJobs = new Map(); // jobId -> { proc, query }
const voiceMemory = require('./voice-memory');

const PORT = 18795;
const GATEWAY_URL = 'http://127.0.0.1:18789';
const GATEWAY_TOKEN = 'ac67a88e680a8ad2d1f42089292c9aa77d8bf6b5a8bab937887c7887d7632314';
const OPENAI_KEY = process.env.OPENAI_API_KEY;
const ELEVENLABS_KEY = process.env.ELEVENLABS_API_KEY;
const VOICE_ID = 'nPczCjzI2devNBz1zQrb'; // Brian - Deep, Resonant
const { execFile } = require('child_process');

// Direct Sonnet (bypass gateway for speed)
const EMERGENT_KEY = 'sk-emergent-5E6Ce8b2cB81618CfC';
const EMERGENT_URL = 'https://integrations.emergentagent.com/llm/v1/messages';
const SONNET_MODEL = 'claude-sonnet-4-5';

function directSonnet(messages, systemPrompt) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify({
      model: SONNET_MODEL,
      max_completion_tokens: 500,
      system: systemPrompt,
      messages: messages,
    });
    const url = new URL(EMERGENT_URL);
    const req = https.request({
      hostname: url.hostname,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${EMERGENT_KEY}`,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData),
      },
    }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try {
          const data = JSON.parse(body);
          const text = data?.content?.[0]?.text || '';
          resolve(text);
        } catch (e) { reject(new Error('Parse error: ' + body.substring(0, 200))); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.write(postData);
    req.end();
  });
}

// ElevenLabs voice name → ID mapping
const EL_VOICES = {
  brian: 'nPczCjzI2devNBz1zQrb',
  roger: 'CwhRBWXzGAHq8TQ4Fs17',
  george: 'JBFqnCBsd6RMkjVDRZzb',
  daniel: 'onwK4e9ZLuTAKqWW03F9',
  lily: 'pFZP5JQG7iQjIQuC4Bku',
  sarah: 'EXAVITQu4vr4xnSDxMaL',
  alice: 'Xb7hH8MSUJpSbSDYk0k2',
  eric: 'cjVigY5qzO86Huf0OWal',
  chris: 'iP95p4xoKVk53GoZ742B',
  nova: '__openai__', // fallback to OpenAI
};

// --- Language detection ---
function detectLanguage(text) {
  // Count CJK characters vs Latin
  const cjk = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/g) || []).length;
  const total = text.replace(/\s/g, '').length;
  if (total === 0) return 'en';
  const ratio = cjk / total;
  console.log(`[lang] CJK: ${cjk}/${total} = ${(ratio*100).toFixed(1)}%`);
  return ratio > 0.15 ? 'zh' : 'en';
}

// --- ElevenLabs TTS ---
function elevenLabsTTS(text, voiceId, res, speed) {
  // ElevenLabs supports speed parameter (0.7 to 1.2 per their docs, but wider range works)
  const elSpeed = Math.min(2.0, Math.max(0.5, speed || 1.0));
  console.log(`[tts-el] Voice: ${voiceId}, Speed: ${elSpeed}`);
  const postData = JSON.stringify({
    text: text,
    model_id: 'eleven_v3',
    voice_settings: {
      stability: 0.5,
      similarity_boost: 0.8,
      style: 0.3,
    },
    speed: elSpeed,
  });

  // Use non-streaming endpoint for reliable Safari playback
  const ttsReq = https.request(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
    method: 'POST',
    headers: {
      'xi-api-key': ELEVENLABS_KEY,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(postData),
      'Accept': 'audio/mpeg',
    },
  }, (ttsRes) => {
    if (ttsRes.statusCode !== 200) {
      let errBody = '';
      ttsRes.on('data', c => errBody += c);
      ttsRes.on('end', () => {
        console.error(`[tts-el] Error ${ttsRes.statusCode}: ${errBody}`);
        openaiTTSFallback(text, speed || 1.5, res);
      });
      return;
    }
    // Buffer the full response before sending (prevents Safari corruption)
    const chunks = [];
    ttsRes.on('data', c => chunks.push(c));
    ttsRes.on('end', () => {
      const buf = Buffer.concat(chunks);
      console.log(`[tts-el] OK, ${buf.length} bytes`);
      res.writeHead(200, {
        'Content-Type': 'audio/mpeg',
        'Content-Length': buf.length,
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache',
      });
      res.end(buf);
    });
  });
  ttsReq.on('error', (err) => {
    console.error('[tts-el] Request error:', err.message);
    openaiTTSFallback(text, speed || 1.5, res);
  });
  ttsReq.write(postData);
  ttsReq.end();
}

// --- OpenAI TTS fallback ---
function openaiTTSFallback(text, speed, res, voice) {
  console.log('[tts] Falling back to OpenAI TTS');
  const ttsReq = https.request('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENAI_KEY}`,
      'Content-Type': 'application/json',
    },
  }, (ttsRes) => {
    res.writeHead(ttsRes.statusCode, {
      'Content-Type': ttsRes.headers['content-type'] || 'audio/mpeg',
      'Access-Control-Allow-Origin': '*'
    });
    ttsRes.pipe(res);
  });
  ttsReq.on('error', (err) => {
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
  });
  ttsReq.write(JSON.stringify({
    model: 'gpt-4o-mini-tts',
    input: text,
    voice: voice || 'nova',
    speed: speed,
    response_format: 'mp3',
  }));
  ttsReq.end();
}

// --- Performance logging ---
const PERF_LOG = '/root/clawd/voice-client/perf.jsonl';
function logPerf(entry) {
  entry.ts = new Date().toISOString();
  const line = JSON.stringify(entry) + '\n';
  fs.appendFile(PERF_LOG, line, () => {});
  console.log(`[perf] ${entry.type}: ${JSON.stringify(entry)}`);
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // GET /api/config — tells client what's preset
  if (req.url === '/api/config' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      hasOpenAI: !!OPENAI_KEY && OPENAI_KEY !== '__OPENAI_KEY__',
      hasElevenLabs: !!ELEVENLABS_KEY && ELEVENLABS_KEY !== '__ELEVENLABS_KEY__',
      voiceId: VOICE_ID,
    }));
    return;
  }

  // POST /api/perf — log client-side timing
  if (req.url === '/api/perf' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        logPerf({ type: 'client', ...data });
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end('{"ok":true}');
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end('{"error":"bad json"}');
      }
    });
    return;
  }

  // GET /api/perf — retrieve performance stats
  if (req.url.startsWith('/api/perf') && req.method === 'GET') {
    try {
      const lines = fs.readFileSync(PERF_LOG, 'utf8').trim().split('\n').filter(l => l);
      const entries = lines.map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
      const last20 = entries.slice(-20);
      const clientEntries = entries.filter(e => e.type === 'client');
      const stats = {
        total: clientEntries.length,
        last20,
        averages: {},
      };
      if (clientEntries.length > 0) {
        const recent = clientEntries.slice(-20);
        const avg = (arr, key) => arr.filter(a => a[key]).reduce((s, a) => s + a[key], 0) / arr.filter(a => a[key]).length;
        stats.averages = {
          stt_ms: Math.round(avg(recent, 'stt_ms')),
          llm_ms: Math.round(avg(recent, 'llm_ms')),
          tts_ms: Math.round(avg(recent, 'tts_ms')),
          total_ms: Math.round(avg(recent, 'total_ms')),
        };
      }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(stats, null, 2));
    } catch (e) {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ total: 0, last20: [], averages: {} }));
    }
    return;
  }

  // --- Voice Memory API ---
  
  // POST /api/voice-memory/save — Save conversation session
  if (req.url === '/api/voice-memory/save' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const result = voiceMemory.saveSession(data.messages, data.metadata);
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify(result));
      } catch (e) {
        console.error('[voice-memory] Save error:', e.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }
  
  // GET /api/voice-memory/recent — Get recent sessions
  if (req.url.startsWith('/api/voice-memory/recent') && req.method === 'GET') {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const limit = parseInt(url.searchParams.get('limit') || '3');
      const sessions = voiceMemory.getRecentSessions(limit);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ sessions }));
    } catch (e) {
      console.error('[voice-memory] Recent error:', e.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }
  
  // POST /api/voice-memory/search — Semantic search
  if (req.url === '/api/voice-memory/search' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const data = JSON.parse(body);
        const limit = parseInt(data.limit || '5');
        const results = await voiceMemory.searchSessions(data.query, limit);
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ results }));
      } catch (e) {
        console.error('[voice-memory] Search error:', e.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }
  
  // GET /api/voice-memory/context — Get memory context for call start
  if (req.url === '/api/voice-memory/context' && req.method === 'GET') {
    try {
      const context = await voiceMemory.getMemoryContext();
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(context));
    } catch (e) {
      console.error('[voice-memory] Context error:', e.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }
  
  // GET /api/voice-memory/session/:id — Get specific session
  if (req.url.startsWith('/api/voice-memory/session/') && req.method === 'GET') {
    try {
      const sessionId = req.url.split('/').pop();
      const session = voiceMemory.getSession(sessionId);
      if (session) {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify(session));
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Session not found' }));
      }
    } catch (e) {
      console.error('[voice-memory] Session error:', e.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // --- Agent Status Dashboard API ---
  // GET /api/agents — get active/recent sub-agent tasks
  if (req.url === '/api/agents' && req.method === 'GET') {
    try {
      const data = fs.readFileSync(path.join(__dirname, 'agents-status.json'), 'utf8');
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(data);
    } catch (e) {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end('[]');
    }
    return;
  }

  // POST /api/agents — update agent status (called by gateway/sub-agents)
  if (req.url === '/api/agents' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const update = JSON.parse(body);
        const file = path.join(__dirname, 'agents-status.json');
        let agents = [];
        try { agents = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {}
        
        // Update or add agent
        const idx = agents.findIndex(a => a.id === update.id);
        if (idx >= 0) agents[idx] = { ...agents[idx], ...update, updatedAt: new Date().toISOString() };
        else agents.push({ ...update, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
        
        // Keep last 20 entries
        agents = agents.slice(-20);
        fs.writeFileSync(file, JSON.stringify(agents, null, 2));
        
        console.log(`[agents] ${update.status}: ${update.task || update.id}`);
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end('{"ok":true}');
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // POST /api/transcribe — proxy to OpenAI Whisper (keys server-side)
  if (req.url === '/api/transcribe' && req.method === 'POST') {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const fullBody = Buffer.concat(chunks);
      console.log(`[transcribe] Content-Type: ${req.headers['content-type']}, Body size: ${fullBody.length}`);
      
      const proxyReq = https.request('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${OPENAI_KEY}`,
          'Content-Type': req.headers['content-type'],
          'Content-Length': fullBody.length,
        },
      }, (proxyRes) => {
        let respBody = '';
        proxyRes.on('data', c => respBody += c);
        proxyRes.on('end', () => {
          console.log(`[transcribe] Response: ${proxyRes.statusCode} ${respBody.substring(0, 200)}`);
          res.writeHead(proxyRes.statusCode, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
          res.end(respBody);
        });
      });
      proxyReq.on('error', (err) => {
        console.error(`[transcribe] Error: ${err.message}`);
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      });
      proxyReq.write(fullBody);
      proxyReq.end();
    });
    return;
  }

  // POST /v1/chat/completions — Direct proxy to gateway (for ElevenLabs Agent)
  if (req.url === '/v1/chat/completions' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      console.log('[el-proxy] Forwarding');
      console.log('[el-proxy] Body preview:', body.substring(0, 200));
      
      let parsed;
      try { parsed = JSON.parse(body); } catch (e) { parsed = {}; }
      const isStream = parsed.stream === true;
      console.log('[el-proxy] Stream:', isStream, 'Messages:', (parsed.messages||[]).length);
      
      // Use DIRECT Sonnet for speed (gateway is too slow, ElevenLabs times out at ~5s)
      const macauTime = new Date().toLocaleString('en-US', { timeZone: 'Asia/Macau', dateStyle: 'full', timeStyle: 'short' });
      
      // Inject memory context
      let memoryContextStr = '';
      try {
        const memContext = await voiceMemory.getMemoryContext();
        if (memContext.has_history && memContext.context_summary) {
          memoryContextStr = `\n\nCONVERSATION MEMORY:\n${memContext.context_summary}`;
        }
      } catch (e) {
        console.warn('[el-proxy] Memory context load failed:', e.message);
      }
      
      const sysPrompt = `You are pia, a fast voice assistant for Pak. Current time in Macau: ${macauTime}. Reply in 1-3 short spoken sentences. No markdown. Be warm and concise.${memoryContextStr}`;
      const msgs = (parsed.messages || []).filter(m => m.role !== 'system').slice(-10);
      
      if (!isStream) {
        // Non-streaming: use directSonnet
        try {
          const reply = await directSonnet(msgs, sysPrompt);
          console.log('[el-proxy] Direct Sonnet reply:', reply.substring(0, 100));
          res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
          res.end(JSON.stringify({
            id: 'el-' + Date.now(),
            object: 'chat.completion',
            model: 'sonnet-direct',
            choices: [{ index: 0, message: { role: 'assistant', content: reply }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          }));
        } catch (err) {
          console.log('[el-proxy] Direct Sonnet error:', err.message);
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: err.message } }));
        }
      } else {
        // Streaming: proxy to gateway with direct Sonnet model
        const streamBody = JSON.stringify({ model: 'sonnet', messages: [{ role: 'system', content: sysPrompt }, ...msgs], stream: true });
        const proxyReq = http.request(`${GATEWAY_URL}/v1/chat/completions`, {
          method: 'POST', timeout: 30000,
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(streamBody),
            'Authorization': `Bearer ${GATEWAY_TOKEN}`,
            'x-clawdbot-agent-id': 'main',
          },
        }, (proxyRes) => {
          res.writeHead(proxyRes.statusCode, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'Access-Control-Allow-Origin': '*',
          });
          proxyRes.pipe(res);
        });
        proxyReq.on('timeout', () => { proxyReq.destroy(); if(!res.headersSent){res.writeHead(504);res.end('{"error":"timeout"}');} });
        proxyReq.on('error', (e) => { if (!res.headersSent) { res.writeHead(502); res.end(JSON.stringify({ error: e.message })); } });
        proxyReq.write(streamBody);
        proxyReq.end();
      }
    });
    req.socket.setTimeout(60000);
    res.socket.setTimeout(60000);
    return;
  }

  // POST /api/chat — Voice-optimized: Direct Sonnet (fast) + Opus delegation via gateway
  if (req.url === '/api/chat' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const parsed = JSON.parse(body);
        const isVoice = parsed.voice !== false;

        if (isVoice) {
          // FAST PATH: Direct Sonnet call (bypasses gateway for ~2s vs ~7s)
          const macauTime = new Date().toLocaleString('en-US', { timeZone: 'Asia/Macau', dateStyle: 'full', timeStyle: 'short' });
          const systemPrompt = `You are pia, a fast voice assistant for Pak. Current time in Macau: ${macauTime}. RULES:
- Reply in 1-3 SHORT sentences. Be conversational and direct.
- Never use markdown, lists, code blocks, or formatting — this is spoken audio.
- If the user asks something that requires deep research, complex analysis, file access, or tools: reply briefly acknowledging it AND add on a NEW LINE: [DELEGATE: brief task description]
- The delegate tag spawns a powerful background agent (Opus with full tools/memory). You don't need to do the work yourself.
- For simple questions (time, weather, opinions, quick facts): just answer directly.
- Match the user's language (English or Cantonese).
- Be warm but concise. Every extra word costs latency.`;

          const msgs = (parsed.messages || []).filter(m => m.role !== 'system').slice(-10);
          
          try {
            const reply = await directSonnet(msgs, systemPrompt);
            console.log(`[voice] Direct Sonnet: "${reply.substring(0, 100)}"`);

            // Check for delegation
            const delegateMatch = reply.match(/\[DELEGATE:\s*(.+?)\]/i);
            let cleanReply = reply;

            if (delegateMatch) {
              const task = delegateMatch[1].trim();
              const agentId = 'delegate-' + Date.now();
              console.log(`[voice] Delegation: "${task}"`);
              cleanReply = reply.replace(/\[DELEGATE:\s*.+?\]/gi, '').trim();

              // Update dashboard
              const agentFile = path.join(__dirname, 'agents-status.json');
              let agents = [];
              try { agents = JSON.parse(fs.readFileSync(agentFile, 'utf8')); } catch (e) {}
              agents.push({ id: agentId, task, status: 'running', model: 'opus', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
              fs.writeFileSync(agentFile, JSON.stringify(agents.slice(-20), null, 2));

              // Spawn Opus sub-agent via gateway (async, don't wait)
              const spawnBody = JSON.stringify({
                model: 'clawdbot',
                messages: [
                  { role: 'system', content: `You are a deep-work sub-agent. Complete this task thoroughly with tools and memory. Write a concise summary when done.\nTask: ${task}` },
                  { role: 'user', content: task }
                ],
                user: `delegate-${parsed.user || 'voice'}`,
              });
              const spawnReq = http.request(`${GATEWAY_URL}/v1/chat/completions`, {
                method: 'POST', timeout: 120000,
                headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(spawnBody), 'Authorization': `Bearer ${GATEWAY_TOKEN}`, 'x-clawdbot-agent-id': 'main' },
              }, (spawnRes) => {
                let sr = '';
                spawnRes.on('data', c => sr += c);
                spawnRes.on('end', () => {
                  try {
                    const result = JSON.parse(sr)?.choices?.[0]?.message?.content || 'Done';
                    let ag = []; try { ag = JSON.parse(fs.readFileSync(agentFile, 'utf8')); } catch (e) {}
                    const idx = ag.findIndex(a => a.id === agentId);
                    if (idx >= 0) { ag[idx].status = 'done'; ag[idx].result = result.substring(0, 500); ag[idx].updatedAt = new Date().toISOString(); }
                    fs.writeFileSync(agentFile, JSON.stringify(ag, null, 2));
                    console.log(`[voice] Delegate done: ${result.substring(0, 80)}`);
                  } catch (e) { console.error('[voice] Delegate error:', e.message); }
                });
              });
              spawnReq.on('error', (err) => {
                console.error('[voice] Delegate spawn error:', err.message);
                let ag = []; try { ag = JSON.parse(fs.readFileSync(agentFile, 'utf8')); } catch (e) {}
                const idx = ag.findIndex(a => a.id === agentId);
                if (idx >= 0) { ag[idx].status = 'error'; ag[idx].result = err.message; ag[idx].updatedAt = new Date().toISOString(); }
                try { fs.writeFileSync(agentFile, JSON.stringify(ag, null, 2)); } catch (e) {}
              });
              spawnReq.write(spawnBody);
              spawnReq.end();
            }

            // Return OpenAI-compatible format
            res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
            res.end(JSON.stringify({
              id: 'voice-' + Date.now(),
              object: 'chat.completion',
              model: 'sonnet-direct',
              choices: [{ index: 0, message: { role: 'assistant', content: cleanReply }, finish_reason: 'stop' }],
            }));
          } catch (err) {
            console.error('[voice] Direct Sonnet failed, falling back to gateway:', err.message);
            // Fallback to gateway
            const fallbackBody = JSON.stringify(parsed);
            const proxyReq = http.request(`${GATEWAY_URL}/v1/chat/completions`, {
              method: 'POST', timeout: 30000,
              headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(fallbackBody), 'Authorization': `Bearer ${GATEWAY_TOKEN}`, 'x-clawdbot-agent-id': 'main' },
            }, (proxyRes) => {
              res.writeHead(proxyRes.statusCode, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
              proxyRes.pipe(res);
            });
            proxyReq.on('error', (e) => { if (!res.headersSent) { res.writeHead(502); res.end(JSON.stringify({ error: e.message })); } });
            proxyReq.write(fallbackBody);
            proxyReq.end();
          }
        } else {
          // Non-voice: proxy to gateway as normal
          const postData = JSON.stringify(parsed);
          const proxyReq = http.request(`${GATEWAY_URL}/v1/chat/completions`, {
            method: 'POST', timeout: 120000,
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData), 'Authorization': `Bearer ${GATEWAY_TOKEN}`, 'x-clawdbot-agent-id': 'main' },
          }, (proxyRes) => {
            res.writeHead(proxyRes.statusCode, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
            proxyRes.pipe(res);
          });
          proxyReq.on('timeout', () => { proxyReq.destroy(); res.writeHead(504); res.end(JSON.stringify({ error: 'Timeout' })); });
          proxyReq.on('error', (e) => { if (!res.headersSent) { res.writeHead(502); res.end(JSON.stringify({ error: e.message })); } });
          proxyReq.write(postData);
          proxyReq.end();
        }
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }
    });
    req.socket.setTimeout(120000);
    res.socket.setTimeout(120000);
    return;
  }

  // POST /api/tts — Hybrid TTS: ElevenLabs (English) + edge-tts (Cantonese)
  if (req.url === '/api/tts' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body);
        const text = (parsed.text || '').substring(0, 4000);
        const speed = Math.min(4.0, Math.max(0.25, parsed.speed || 1.5));
        const lang = detectLanguage(text);
        
        console.log(`[tts] Lang: ${lang}, Length: ${text.length}, Speed: ${speed}`);
        
        if (lang === 'zh') {
          // Cantonese/Chinese → edge-tts (Microsoft Neural, free)
          const cantoVoice = parsed.cantoVoice || 'zh-HK-HiuMaanNeural';
          const ratePercent = Math.round((speed - 1) * 100);
          const rateStr = ratePercent >= 0 ? `+${ratePercent}%` : `${ratePercent}%`;
          const tmpFile = `/tmp/edge-tts-${Date.now()}.mp3`;
          
          execFile('edge-tts', [
            '--voice', cantoVoice,
            '--rate', rateStr,
            '--text', text,
            '--write-media', tmpFile
          ], { timeout: 30000 }, (err) => {
            if (err) {
              console.error('[tts-edge] Error:', err.message);
              // Fallback to ElevenLabs
              elevenLabsTTS(text, VOICE_ID, res);
              return;
            }
            try {
              const audio = fs.readFileSync(tmpFile);
              res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Access-Control-Allow-Origin': '*' });
              res.end(audio);
              fs.unlinkSync(tmpFile);
            } catch (e) {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Failed to read edge-tts output' }));
            }
          });
        } else {
          // English → ElevenLabs (Brian)
          const voiceName = parsed.elVoice || 'brian';
          const voiceId = EL_VOICES[voiceName] || voiceName;
          if (voiceId === '__openai__') {
            openaiTTSFallback(text, speed, res, voiceName);
          } else {
            elevenLabsTTS(text, voiceId, res, speed);
          }
        }
      } catch (e) {
        console.error('[tts] Parse error:', e.message);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid request body' }));
      }
    });
    return;
  }

  // POST /api/el-tool — ElevenLabs agent webhook tool (HYBRID)
  // Tries synchronous first (15s), falls back to async for long tasks
  if (req.url === '/api/el-tool' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      let responded = false;
      const respond = (result) => {
        if (responded) return;
        responded = true;
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ result }));
      };

      try {
        const parsed = JSON.parse(body);
        console.log(`[el-tool] Query: "${parsed.query}"`);
        
        const jobId = 'job_' + Date.now();
        const escapedQuery = parsed.query.replace(/"/g, '\\"').replace(/\$/g, '\\$');
        
        // Log as pending
        try {
          const jh = require('./job-history');
          jh.addJob({ id: jobId, query: parsed.query, status: 'pending', timestamp: new Date().toISOString() });
        } catch (e) {}
        
        // Run gateway query — try to finish in 15s (synchronous)
        const { exec } = require('child_process');
        const proc = exec(`python3 /root/clawd/voice-client/gateway-query.py "${escapedQuery}"`, 
          { timeout: 120000, shell: '/bin/bash', maxBuffer: 1024 * 1024 });
        
        // Track for abort
        runningJobs.set(jobId, { proc, query: parsed.query });
        
        let stdout = '';
        proc.stdout.on('data', d => stdout += d);
        proc.stderr.on('data', d => stdout += d);
        
        proc.on('close', (code) => {
          runningJobs.delete(jobId);
          const result = stdout.trim() || 'Could not process that request.';
          console.log(`[el-tool] Result (${responded ? 'async' : 'sync'}): ${result.substring(0, 80)}...`);
          
          // Update history
          try {
            const jh = require('./job-history');
            jh.addJob({ id: jobId, query: parsed.query, status: 'done', result, completedAt: new Date().toISOString() });
          } catch (e) {}
          
          // Write result file for sidebar
          fs.writeFileSync(`/root/clawd/voice-client/jobs/${jobId}.result`, result);
          
          if (!responded) {
            // Finished within timeout — return directly!
            respond(result);
          }
          // If already responded with "still working", result is in check_results
        });
        
        // 15s timeout — if not done yet, return async message
        setTimeout(() => {
          if (!responded) {
            console.log(`[el-tool] Job ${jobId} taking >15s, going async`);
            respond("Still working on that — it's a complex query. Call check_results in about 10 seconds to get the answer.");
          }
        }, 15000);
        
      } catch (e) {
        console.error('[el-tool] Error:', e.message);
        respond('Error processing request.');
      }
    });
    return;
  }

  // POST /api/transcript-log — Log a transcript entry from frontend
  if (req.url === '/api/transcript-log' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const entry = JSON.parse(body);
        const logFile = '/root/clawd/voice-client/jobs/transcript.json';
        let log = [];
        try { log = JSON.parse(fs.readFileSync(logFile, 'utf8')); } catch(e) {}
        log.push(entry);
        if (log.length > 500) log = log.slice(-500);
        fs.writeFileSync(logFile, JSON.stringify(log, null, 2));
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end('{"ok":true}');
      } catch(e) {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end('{"ok":false}');
      }
    });
    return;
  }

  // GET /api/transcript-export — Export full transcript (voice + jobs) as markdown
  if (req.url === '/api/transcript-export' && req.method === 'GET') {
    try {
      // Load voice transcript
      const logFile = '/root/clawd/voice-client/jobs/transcript.json';
      let voiceLog = [];
      try { voiceLog = JSON.parse(fs.readFileSync(logFile, 'utf8')); } catch(e) {}
      
      // Load job history
      const jh = require('./job-history');
      const jobs = jh.getAllJobs().filter(j => j.status === 'done' && j.result);
      
      // Merge voice + jobs by timestamp
      const allEntries = [];
      
      voiceLog.forEach(v => {
        allEntries.push({
          time: v.time,
          type: v.role === 'user' ? '🎤 User' : '🔮 pia',
          text: v.text
        });
      });
      
      jobs.forEach(j => {
        allEntries.push({
          time: j.timestamp,
          type: '📤 Job Submitted',
          text: j.query || 'Task'
        });
        const duration = j.completedAt ? Math.round((new Date(j.completedAt) - new Date(j.timestamp)) / 1000) : '?';
        allEntries.push({
          time: j.completedAt || j.timestamp,
          type: `📥 Job Result (${duration}s)`,
          text: j.result
        });
      });
      
      // Sort by time
      allEntries.sort((a, b) => a.time.localeCompare(b.time));
      
      // Format as markdown
      let md = `# pia Voice Session Transcript\n`;
      md += `**Date:** ${new Date().toISOString().slice(0,10)}\n`;
      md += `**Entries:** ${allEntries.length}\n\n---\n\n`;
      
      allEntries.forEach(e => {
        const t = new Date(e.time).toLocaleTimeString('en-US', { hour12: false, timeZone: 'Asia/Macau' });
        md += `**[${t}] ${e.type}**\n${e.text}\n\n`;
      });
      
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ transcript: md }));
    } catch(e) {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ transcript: 'Error generating transcript: ' + e.message }));
    }
    return;
  }

  // POST /api/transcript-save-memory — Save full transcript to daily memory file
  if (req.url === '/api/transcript-save-memory' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        // Load voice transcript
        const logFile = '/root/clawd/voice-client/jobs/transcript.json';
        let voiceLog = [];
        try { voiceLog = JSON.parse(fs.readFileSync(logFile, 'utf8')); } catch(e) {}
        
        // Load job history
        const jh = require('./job-history');
        const jobs = jh.getAllJobs().filter(j => j.status === 'done' && j.result);
        
        // Build merged transcript
        const allEntries = [];
        voiceLog.forEach(v => {
          allEntries.push({ time: v.time, type: v.role === 'user' ? '🎤 User' : '🔮 pia', text: v.text });
        });
        jobs.forEach(j => {
          allEntries.push({ time: j.timestamp, type: '📤 Job', text: j.query || 'Task' });
          const dur = j.completedAt ? Math.round((new Date(j.completedAt) - new Date(j.timestamp)) / 1000) + 's' : '';
          allEntries.push({ time: j.completedAt || j.timestamp, type: `📥 Result (${dur})`, text: j.result });
        });
        allEntries.sort((a, b) => a.time.localeCompare(b.time));
        
        if (allEntries.length === 0) {
          res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
          res.end(JSON.stringify({ ok: true, file: 'none', reason: 'empty' }));
          return;
        }
        
        // Format for memory file
        const now = new Date();
        const macauOffset = 8 * 60 * 60 * 1000;
        const macauDate = new Date(now.getTime() + macauOffset);
        const dateStr = macauDate.toISOString().slice(0, 10);
        const memFile = `/root/clawd/memory/${dateStr}.md`;
        
        let md = `\n\n## 🎙️ Voice Session (${new Date(allEntries[0].time).toLocaleTimeString('en-US', { hour12: true, timeZone: 'Asia/Macau' })} - ${new Date(allEntries[allEntries.length-1].time).toLocaleTimeString('en-US', { hour12: true, timeZone: 'Asia/Macau' })})\n\n`;
        
        allEntries.forEach(e => {
          const t = new Date(e.time).toLocaleTimeString('en-US', { hour12: false, timeZone: 'Asia/Macau' });
          md += `- **[${t}] ${e.type}:** ${e.text.substring(0, 300)}\n`;
        });
        
        // Append to daily memory file
        fs.appendFileSync(memFile, md);
        
        // Clear transcript log for fresh session
        fs.writeFileSync(logFile, '[]');
        
        console.log(`[memory] Saved voice transcript to ${memFile} (${allEntries.length} entries)`);
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ ok: true, file: memFile, entries: allEntries.length }));
      } catch(e) {
        console.error('[memory] Save failed:', e);
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // POST /api/el-abort-jobs — Abort running background jobs
  if (req.url === '/api/el-abort-jobs' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const parsed = body ? JSON.parse(body) : {};
        const targetId = parsed.job_id; // optional: abort specific job
        
        let aborted = 0;
        let abortedList = [];
        
        if (targetId && runningJobs.has(targetId)) {
          // Abort specific job
          const job = runningJobs.get(targetId);
          try { job.proc.kill('SIGTERM'); } catch(e) {}
          runningJobs.delete(targetId);
          aborted = 1;
          abortedList.push(targetId);
          
          // Update history
          try {
            const jh = require('./job-history');
            jh.addJob({ id: targetId, query: job.query, status: 'aborted', result: 'Aborted by user', completedAt: new Date().toISOString() });
          } catch(e) {}
        } else {
          // Abort ALL running jobs
          for (const [id, job] of runningJobs.entries()) {
            try { job.proc.kill('SIGTERM'); } catch(e) {}
            abortedList.push(id);
            aborted++;
            
            try {
              const jh = require('./job-history');
              jh.addJob({ id, query: job.query, status: 'aborted', result: 'Aborted by user', completedAt: new Date().toISOString() });
            } catch(e) {}
          }
          runningJobs.clear();
        }
        
        console.log(`[abort] Aborted ${aborted} job(s): ${abortedList.join(', ')}`);
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ result: aborted > 0 ? `Aborted ${aborted} job(s). ${abortedList.join(', ')}` : 'No running jobs to abort.' }));
      } catch(e) {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ result: 'Abort failed: ' + e.message }));
      }
    });
    return;
  }

  // POST /api/el-memory-search — Search memory files for the voice agent
  if (req.url === '/api/el-memory-search' && (req.method === 'POST' || req.method === 'GET')) {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const parsed = body ? JSON.parse(body) : {};
        const query = parsed.query || 'recent';
        console.log(`[memory-search] Query: "${query}"`);
        
        const { execSync } = require('child_process');
        
        // Search memory files using grep
        const escapedQuery = query.replace(/"/g, '\\"').replace(/\$/g, '\\$');
        let results = '';
        
        try {
          // Search today's memory + recent files
          const macauDate = new Date(Date.now() + 8*60*60*1000).toISOString().slice(0,10);
          const yesterday = new Date(Date.now() + 8*60*60*1000 - 86400000).toISOString().slice(0,10);
          
          // Get today's memory
          try {
            const today = execSync(`head -100 /root/clawd/memory/${macauDate}.md 2>/dev/null || echo "No entries today"`, { timeout: 5000 }).toString();
            results += `=== Today (${macauDate}) ===\n${today.substring(0, 2000)}\n\n`;
          } catch(e) {}
          
          // Search across all memory for the query
          try {
            const grepResults = execSync(`grep -rli "${escapedQuery}" /root/clawd/memory/*.md 2>/dev/null | head -5`, { timeout: 5000 }).toString();
            if (grepResults.trim()) {
              const files = grepResults.trim().split('\n');
              for (const file of files.slice(0, 3)) {
                try {
                  const context = execSync(`grep -B 2 -A 5 -i "${escapedQuery}" "${file}" 2>/dev/null | head -30`, { timeout: 3000 }).toString();
                  results += `=== ${file.split('/').pop()} ===\n${context.substring(0, 1000)}\n\n`;
                } catch(e) {}
              }
            }
          } catch(e) {}
          
          // Search MEMORY.md for long-term context
          try {
            const memoryMd = execSync(`grep -B 1 -A 3 -i "${escapedQuery}" /root/clawd/MEMORY.md 2>/dev/null | head -30`, { timeout: 3000 }).toString();
            if (memoryMd.trim()) {
              results += `=== Long-term Memory ===\n${memoryMd.substring(0, 1000)}\n\n`;
            }
          } catch(e) {}
          
        } catch(e) {
          results = 'Memory search failed: ' + e.message;
        }
        
        if (!results.trim()) results = `No memory found for "${query}". Try a different search term.`;
        
        console.log(`[memory-search] Found ${results.length} chars`);
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ result: results.substring(0, 3000) }));
      } catch(e) {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ result: 'Memory search error.' }));
      }
    });
    return;
  }

  // ========== TIER 2: FAST DIRECT TOOLS ==========

  // Tier 2 activity log (polled by frontend for debug panel)
  if (!global._tier2Log) global._tier2Log = [];
  
  function logTier2(tool, query, status, elapsed, result) {
    global._tier2Log.push({ tool, query, status, elapsed, result: result || null, ts: Date.now() });
    if (global._tier2Log.length > 20) global._tier2Log.shift();
  }

  // GET /api/tier2-status — Frontend polls for Tier 2 activity
  if (req.url === '/api/tier2-status' && req.method === 'GET') {
    const since = Date.now() - 30000; // last 30s
    const recent = (global._tier2Log || []).filter(e => e.ts > since);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ events: recent }));
    return;
  }

  // POST /api/el-quick-search — Fast web search via Brave + GPT-4o-mini synthesis (2-5s)
  if (req.url === '/api/el-quick-search' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { query } = JSON.parse(body);
        console.log(`[tier2] quick_search: "${query}"`);
        const startTime = Date.now();
        logTier2('quick_search', query, 'running', 0);
        
        // Step 1: Brave Search (1-2s)
        const braveKey = process.env.BRAVE_API_KEY;
        
        let searchResults = '';
        if (braveKey) {
          const braveResp = await new Promise((resolve, reject) => {
            const braveReq = https.request({
              hostname: 'api.search.brave.com',
              path: `/res/v1/web/search?q=${encodeURIComponent(query)}&count=8`,
              headers: { 'X-Subscription-Token': braveKey, 'Accept': 'application/json' }
            }, (r) => { let d = ''; r.on('data', c => d += c); r.on('end', () => resolve(d)); });
            braveReq.on('error', reject);
            braveReq.setTimeout(4000, () => { braveReq.destroy(); reject(new Error('timeout')); });
            braveReq.end();
          });
          const braveData = JSON.parse(braveResp);
          searchResults = (braveData.web?.results || []).slice(0, 5)
            .map(r => `${r.title}: ${r.description}`).join('\n');
        }
        
        // Step 2: GPT-4o-mini synthesis (1-2s)
        const openaiKey = process.env.OPENAI_API_KEY;
        const macauTime = new Date().toLocaleString('en-US', { timeZone: 'Asia/Macau' });
        
        const gptBody = JSON.stringify({
          model: 'gpt-4.1',
          messages: [
            { role: 'system', content: `You are a fast, accurate voice assistant. Answer in 2-3 concise spoken sentences. Be specific with numbers, dates, and facts. Current time: ${macauTime} (Macau). Use the search results below to answer accurately. If results are insufficient, say so honestly.\n\nSearch results:\n${searchResults || 'No search results available.'}` },
            { role: 'user', content: query }
          ],
          max_completion_tokens: 500,
        });
        
        const gptResp = await new Promise((resolve, reject) => {
          const gptReq = https.request({
            hostname: 'api.openai.com',
            path: '/v1/chat/completions',
            method: 'POST',
            headers: { 'Authorization': `Bearer ${openaiKey}`, 'Content-Type': 'application/json' }
          }, (r) => { let d = ''; r.on('data', c => d += c); r.on('end', () => resolve(d)); });
          gptReq.on('error', reject);
          gptReq.setTimeout(8000, () => { gptReq.destroy(); reject(new Error('timeout')); });
          gptReq.write(gptBody);
          gptReq.end();
        });
        
        const gptParsed = JSON.parse(gptResp);
        if (gptParsed.error) {
          console.error('[tier2] OpenAI error:', JSON.stringify(gptParsed.error));
        }
        const answer = gptParsed.choices?.[0]?.message?.content || gptParsed.error?.message || 'Could not get an answer.';
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`[tier2] quick_search done in ${elapsed}s: ${answer.substring(0, 80)}`);
        logTier2('quick_search', query, 'done', elapsed, answer);
        
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ result: answer }));
      } catch(e) {
        console.error('[tier2] quick_search error:', e.message);
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ result: `Search failed: ${e.message}. Try gateway_action instead.` }));
      }
    });
    return;
  }

  // POST /api/el-quick-ask — Fast LLM response via GPT-4o-mini (1-3s) for reasoning/analysis
  if (req.url === '/api/el-quick-ask' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { question, context } = JSON.parse(body);
        console.log(`[tier2] quick_ask: "${question}"`);
        const startTime = Date.now();
        logTier2('quick_ask', question, 'running', 0);
        
        const openaiKey = process.env.OPENAI_API_KEY;
        const macauTime = new Date().toLocaleString('en-US', { timeZone: 'Asia/Macau' });
        
        const gptBody = JSON.stringify({
          model: 'gpt-4.1',
          messages: [
            { role: 'system', content: `You are a fast, concise assistant for Pak Hou Chau. Answer in 2-3 spoken sentences. Current time: ${macauTime} (Macau GMT+8). Be direct and accurate.${context ? '\n\nContext: ' + context : ''}` },
            { role: 'user', content: question }
          ],
          max_completion_tokens: 500,
        });
        
        const gptResp = await new Promise((resolve, reject) => {
          const gptReq = https.request({
            hostname: 'api.openai.com',
            path: '/v1/chat/completions',
            method: 'POST',
            headers: { 'Authorization': `Bearer ${openaiKey}`, 'Content-Type': 'application/json' }
          }, (r) => { let d = ''; r.on('data', c => d += c); r.on('end', () => resolve(d)); });
          gptReq.on('error', reject);
          gptReq.setTimeout(6000, () => { gptReq.destroy(); reject(new Error('timeout')); });
          gptReq.write(gptBody);
          gptReq.end();
        });
        
        const gptParsed = JSON.parse(gptResp);
        if (gptParsed.error) {
          console.error('[tier2] quick_ask OpenAI error:', JSON.stringify(gptParsed.error));
        }
        const answer = gptParsed.choices?.[0]?.message?.content || gptParsed.error?.message || 'Could not generate answer.';
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`[tier2] quick_ask done in ${elapsed}s: ${answer.substring(0, 80)}`);
        logTier2('quick_ask', question, 'done', elapsed, answer);
        
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ result: answer }));
      } catch(e) {
        console.error('[tier2] quick_ask error:', e.message);
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ result: `Ask failed: ${e.message}. Try gateway_action instead.` }));
      }
    });
    return;
  }

  // POST /api/voice-save-session — Save session transcript + facts after call ends
  if (req.url === '/api/voice-save-session' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const session = JSON.parse(body);
        const macauDate = new Date(Date.now() + 8*60*60*1000).toISOString().slice(0,10);
        const macauTime = new Date(Date.now() + 8*60*60*1000).toISOString().slice(11,16).replace(':', '-');
        
        // Save individual session
        const sessionFile = `/root/clawd/voice-client/memory/sessions/${macauDate}_${macauTime}.json`;
        fs.writeFileSync(sessionFile, JSON.stringify(session, null, 2));
        
        // Auto-extract facts and add to voice-memory.json
        const memFile = '/root/clawd/voice-client/memory/voice-memory.json';
        let mem = { facts: [], preferences: [], lastUpdated: null };
        try { mem = JSON.parse(fs.readFileSync(memFile, 'utf8')); } catch(e) {}
        
        if (session.facts) {
          for (const fact of session.facts) {
            mem.facts.push({
              query: fact.query,
              summary: (fact.summary || '').substring(0, 200),
              date: macauDate,
              time: fact.time || macauTime
            });
          }
        }
        
        // Cap at 50 facts, drop oldest
        if (mem.facts.length > 50) mem.facts = mem.facts.slice(-50);
        mem.lastUpdated = new Date().toISOString();
        
        fs.writeFileSync(memFile, JSON.stringify(mem, null, 2));
        console.log(`[voice-mem] Saved session ${sessionFile}, ${mem.facts.length} total facts`);
        
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ ok: true, totalFacts: mem.facts.length }));
      } catch(e) {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // POST /api/voice-save-memory — Agent explicitly saves a preference/fact
  if (req.url === '/api/voice-save-memory' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { fact, type } = JSON.parse(body);
        const memFile = '/root/clawd/voice-client/memory/voice-memory.json';
        let mem = { facts: [], preferences: [], lastUpdated: null };
        try { mem = JSON.parse(fs.readFileSync(memFile, 'utf8')); } catch(e) {}
        
        const entry = { text: fact, date: new Date().toISOString(), source: 'agent' };
        
        if (type === 'preference') {
          mem.preferences.push(entry);
          if (mem.preferences.length > 20) mem.preferences = mem.preferences.slice(-20);
        } else {
          mem.facts.push({ query: 'agent_note', summary: fact, date: new Date().toISOString().slice(0,10) });
          if (mem.facts.length > 50) mem.facts = mem.facts.slice(-50);
        }
        
        mem.lastUpdated = new Date().toISOString();
        fs.writeFileSync(memFile, JSON.stringify(mem, null, 2));
        
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ result: `Saved to memory: "${fact}"` }));
      } catch(e) {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ result: 'Failed to save.' }));
      }
    });
    return;
  }

  // GET /api/voice-context — Context for session start (short-term memory)
  if (req.url === '/api/voice-context' && req.method === 'GET') {
    try {
      const { execSync } = require('child_process');
      const macauDate = new Date(Date.now() + 8*60*60*1000).toISOString().slice(0,10);
      const macauTime = new Date().toLocaleTimeString('en-US', { timeZone: 'Asia/Macau', hour12: true });
      
      let context = `Current time: ${macauTime} Macau time, ${macauDate}\n\n`;
      
      // Load persistent voice memory
      try {
        const mem = JSON.parse(fs.readFileSync('/root/clawd/voice-client/memory/voice-memory.json', 'utf8'));
        
        // Preferences
        if (mem.preferences && mem.preferences.length > 0) {
          context += `=== Pak's Preferences ===\n`;
          mem.preferences.forEach(p => { context += `• ${p.text}\n`; });
          context += '\n';
        }
        
        // Recent facts from previous sessions (last 10)
        if (mem.facts && mem.facts.length > 0) {
          const recentFacts = mem.facts.slice(-10);
          context += `=== Previous Session Facts ===\n`;
          recentFacts.forEach(f => {
            context += `[${f.date}] ${f.query}: ${f.summary}\n`;
          });
          context += '\n';
        }
      } catch(e) {}
      
      // Last 3 session summaries
      try {
        const sessDir = '/root/clawd/voice-client/memory/sessions';
        const files = fs.readdirSync(sessDir).sort().reverse().slice(0, 3);
        if (files.length > 0) {
          context += `=== Recent Voice Sessions ===\n`;
          for (const f of files) {
            try {
              const sess = JSON.parse(fs.readFileSync(`${sessDir}/${f}`, 'utf8'));
              const summary = (sess.facts || []).map(f => f.query).join(', ');
              context += `${f.replace('.json', '')}: ${summary || 'no queries'}\n`;
            } catch(e) {}
          }
          context += '\n';
        }
      } catch(e) {}
      
      // Today's calendar
      try {
        const cal = execSync('cd /root/clawd/google-calendar && ./gcal today 2>/dev/null | head -20', { timeout: 8000 }).toString();
        context += `=== Today's Calendar ===\n${cal.substring(0, 500)}\n\n`;
      } catch(e) {}
      
      // Today's memory highlights
      try {
        const todayMem = execSync(`head -50 /root/clawd/memory/${macauDate}.md 2>/dev/null`, { timeout: 3000 }).toString();
        if (todayMem.trim()) {
          context += `=== Today's Notes ===\n${todayMem.substring(0, 800)}\n\n`;
        }
      } catch(e) {}
      
      // Recent job results from this session
      try {
        const jh = require('./job-history');
        const jobs = jh.getAllJobs().filter(j => j.status === 'done').slice(-5);
        if (jobs.length > 0) {
          context += `=== Recent Lookups (this session) ===\n`;
          jobs.forEach(j => {
            context += `Q: ${j.query}\nA: ${(j.result || '').substring(0, 150)}\n\n`;
          });
        }
      } catch(e) {}
      
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ context: context.substring(0, 5000) }));
    } catch(e) {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ context: 'Could not load context.' }));
    }
    return;
  }

  // GET /api/jobs-status — Dashboard API for job monitoring
  if (req.url === '/api/jobs-status' && req.method === 'GET') {
    try {
      const jobs = jobHistory.getAllJobs();
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ jobs: jobs.slice(0, 50) }));
    } catch (e) {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ jobs: [] }));
    }
    return;
  }

  // GET /api/el-check-results — Return ALL recent completed results + pending status
  if (req.url === '/api/el-check-results' && (req.method === 'GET' || req.method === 'POST')) {
    try {
      const jobHistoryMod = require('./job-history');
      const history = jobHistoryMod.getAllJobs();
      
      const doneJobs = history.filter(j => j.status === 'done' && j.result).slice(0, 10);
      const pendingJobs = history.filter(j => j.status === 'pending');
      
      if (doneJobs.length === 0 && pendingJobs.length === 0) {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ result: "No results yet. Ask me something!" }));
        return;
      }
      
      let output = '';
      if (pendingJobs.length > 0) {
        output += `⏳ ${pendingJobs.length} job(s) still running: ${pendingJobs.map(j => j.query).join(', ')}\n\n`;
      }
      if (doneJobs.length > 0) {
        output += doneJobs.map((j, i) => {
          const dur = j.completedAt ? Math.round((new Date(j.completedAt) - new Date(j.timestamp)) / 1000) + 's' : '';
          return `[${i+1}] Query: "${j.query}" (${dur})\nResult: ${j.result}`;
        }).join('\n\n');
      }
      
      console.log(`[check-results] Returning ${doneJobs.length} results, ${pendingJobs.length} pending`);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ result: output }));
    } catch (e) {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ result: "Error checking results." }));
    }
    return;
  }

  // GET /api/el-job-history — Full job history for the agent
  if ((req.url === '/api/el-job-history' || req.url === '/api/job-history') && (req.method === 'GET' || req.method === 'POST')) {
    try {
      const jobHistoryMod = require('./job-history');
      const history = jobHistoryMod.getAllJobs();
      
      const allJobs = history.slice(0, 20);
      
      if (allJobs.length === 0) {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ result: "No job history yet." }));
        return;
      }
      
      const summary = allJobs.map((j, i) => {
        const dur = (j.completedAt && j.timestamp) ? Math.round((new Date(j.completedAt) - new Date(j.timestamp)) / 1000) + 's' : 'N/A';
        const time = j.timestamp ? new Date(j.timestamp).toLocaleTimeString('en-US', { hour12: true, timeZone: 'Asia/Macau' }) : '?';
        const status = j.status === 'done' ? '✅' : j.status === 'pending' ? '⏳' : '❌';
        return `${status} [${time}] "${j.query || 'Task'}" (${dur})${j.result ? '\n   → ' + j.result.substring(0, 200) : ''}`;
      }).join('\n\n');
      
      console.log(`[job-history] Returning ${allJobs.length} jobs`);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ result: `📋 Job History (${allJobs.length} jobs):\n\n${summary}` }));
    } catch (e) {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ result: "Error loading history." }));
    }
    return;
  }

  // ElevenLabs signed URL for Conversational AI
  if (req.url === '/api/signed-url' && req.method === 'GET') {
    const agentId = 'agent_2701khdf1eqke629dd7qwp2681ts';
    const elReq = https.request({
      hostname: 'api.elevenlabs.io',
      path: `/v1/convai/conversation/get-signed-url?agent_id=${agentId}`,
      method: 'GET',
      headers: { 'xi-api-key': ELEVENLABS_KEY },
    }, (elRes) => {
      let data = '';
      elRes.on('data', c => data += c);
      elRes.on('end', () => {
        console.log('[el-signed] Response:', elRes.statusCode, data.substring(0, 100));
        res.writeHead(elRes.statusCode, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(data);
      });
    });
    elReq.on('error', (e) => { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); });
    elReq.end();
    return;
  }

  // Serve static files
  let filePath = req.url === '/' ? '/index.html' : req.url === '/drive' ? '/drive.html' : req.url === '/call' ? '/el-agent.html' : req.url === '/jobs' ? '/jobs.html' : req.url === '/test' ? '/test.html' : req.url;
  filePath = path.join(__dirname, filePath);
  const ext = path.extname(filePath);
  const mimeTypes = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css' };
  try {
    const content = fs.readFileSync(filePath);
    res.writeHead(200, { 
      'Content-Type': mimeTypes[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0',
    });
    res.end(content);
  } catch (e) {
    res.writeHead(404); res.end('Not found');
  }
});

// ── Inline Voice Pipeline (STT + LLM + TTS) ──
const WebSocket = require('ws');
// No external deps needed - using raw multipart

const wss = new WebSocket.Server({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  if (req.url === '/voice/ws' || req.url === '/ws') {
    wss.handleUpgrade(req, socket, head, (ws) => {
      console.log('[voice] Client connected');
      let audioBuffers = [];
      let isListening = false;
      
      ws.on('message', async (raw) => {
        let msg;
        try { msg = JSON.parse(raw); } catch { return; }
        
        if (msg.type === 'start_listening') {
          isListening = true;
          audioBuffers = [];
          ws.send(JSON.stringify({ type: 'listening_started' }));
          console.log('[voice] Listening started');
        }
        else if (msg.type === 'audio' && isListening) {
          // Accumulate float32 base64 audio chunks
          audioBuffers.push(msg.data);
          // Simple VAD: just acknowledge
          ws.send(JSON.stringify({ type: 'vad_status', speech_detected: true }));
        }
        else if (msg.type === 'stop_listening') {
          isListening = false;
          ws.send(JSON.stringify({ type: 'listening_stopped' }));
          console.log('[voice] Stopped, processing', audioBuffers.length, 'chunks');
          
          if (audioBuffers.length < 5) {
            ws.send(JSON.stringify({ type: 'transcript', text: '', final: true }));
            return;
          }
          
          try {
            // 1. Combine float32 chunks → WAV buffer
            const totalSamples = audioBuffers.reduce((n, b64) => n + Buffer.from(b64, 'base64').length / 4, 0);
            const wavBuf = createWav(audioBuffers, 16000);
            console.log('[voice] WAV:', (wavBuf.length/1024).toFixed(1), 'KB,', totalSamples, 'samples');
            
            // 2. STT via OpenAI Whisper
            const transcript = await whisperSTT(wavBuf);
            console.log('[voice] Transcript:', transcript);
            ws.send(JSON.stringify({ type: 'transcript', text: transcript, final: true }));
            
            if (!transcript.trim()) return;
            
            // 3. LLM via Direct Sonnet
            const macauTime = new Date().toLocaleString('en-US', { timeZone: 'Asia/Macau', dateStyle: 'full', timeStyle: 'short' });
            const sysPrompt = `You are pia, a voice assistant for Pak in drive mode. Current time: ${macauTime}. Be concise — 1-3 spoken sentences. No markdown.`;
            const reply = await directSonnet([{ role: 'user', content: transcript }], sysPrompt);
            console.log('[voice] Reply:', reply.substring(0, 80));
            
            // 4. TTS via ElevenLabs
            const audioB64 = await elevenLabsTTS(reply);
            if (audioB64) {
              ws.send(JSON.stringify({ type: 'audio_chunk', data: audioB64, sample_rate: 24000 }));
            }
            ws.send(JSON.stringify({ type: 'response_complete', text: reply }));
            
          } catch (err) {
            console.error('[voice] Pipeline error:', err.message);
            ws.send(JSON.stringify({ type: 'error', message: err.message }));
          }
        }
        else if (msg.type === 'ping') {
          ws.send(JSON.stringify({ type: 'pong' }));
        }
      });
      
      ws.on('close', () => console.log('[voice] Client disconnected'));
      ws.on('error', (e) => console.log('[voice] Error:', e.message));
    });
  } else {
    socket.destroy();
  }
});

// Create WAV from float32 base64 chunks
function createWav(chunks, sampleRate) {
  // Decode all chunks
  const floatArrays = chunks.map(b64 => {
    const buf = Buffer.from(b64, 'base64');
    return new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4);
  });
  const totalSamples = floatArrays.reduce((n, a) => n + a.length, 0);
  
  // Convert float32 → int16
  const int16 = new Int16Array(totalSamples);
  let offset = 0;
  for (const fa of floatArrays) {
    for (let i = 0; i < fa.length; i++) {
      int16[offset++] = Math.max(-32768, Math.min(32767, Math.round(fa[i] * 32767)));
    }
  }
  
  // WAV header
  const dataSize = int16.length * 2;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); // chunk size
  header.writeUInt16LE(1, 20);  // PCM
  header.writeUInt16LE(1, 22);  // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); // byte rate
  header.writeUInt16LE(2, 32);  // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);
  
  return Buffer.concat([header, Buffer.from(int16.buffer)]);
}

// OpenAI Whisper STT
async function whisperSTT(wavBuffer) {
  const boundary = '----FormBound' + Date.now();
  const parts = [];
  parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.wav"\r\nContent-Type: audio/wav\r\n\r\n`);
  parts.push(wavBuffer);
  parts.push(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-1\r\n--${boundary}--\r\n`);
  
  const body = Buffer.concat(parts.map(p => typeof p === 'string' ? Buffer.from(p) : p));
  
  return new Promise((resolve, reject) => {
    const https = require('https');
    const req = https.request({
      hostname: 'api.openai.com',
      path: '/v1/audio/transcriptions',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length,
      },
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data).text || ''); }
        catch { resolve(''); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ElevenLabs TTS
async function elevenLabsTTS(text) {
  const EL_KEY = process.env.ELEVENLABS_API_KEY;
  if (!EL_KEY) return null;
  
  return new Promise((resolve, reject) => {
    const https = require('https');
    const body = JSON.stringify({
      text,
      model_id: 'eleven_turbo_v2_5',
      output_format: 'pcm_24000',
    });
    const req = https.request({
      hostname: 'api.elevenlabs.io',
      path: '/v1/text-to-speech/21m00Tcm4TlvDq8ikWAM', // Rachel voice
      method: 'POST',
      headers: {
        'xi-api-key': EL_KEY,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'Accept': 'audio/pcm',
      },
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const pcm = Buffer.concat(chunks);
        resolve(pcm.toString('base64'));
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🎙️ pia Voice Client running on http://0.0.0.0:${PORT}`);
  console.log(`  OpenAI: ${OPENAI_KEY ? '✅ configured' : '❌ missing'}`);
  console.log(`  ElevenLabs: ${ELEVENLABS_KEY && ELEVENLABS_KEY !== '__ELEVENLABS_KEY__' ? '✅ configured' : '⚠️ client must provide'}`);
});
