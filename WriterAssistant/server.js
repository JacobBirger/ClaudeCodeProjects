'use strict';

require('dotenv').config();

const express = require('express');
const path = require('path');
const apiRouter = require('./routes/api');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// API routes
app.use('/api', apiRouter);

// Fallback: serve index.html for any non-API route
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Validate config on startup
const provider = (process.env.PROVIDER || 'anthropic').toLowerCase();
if (provider === 'anthropic' && !process.env.ANTHROPIC_API_KEY) {
  console.warn('\n[WARNING] ANTHROPIC_API_KEY is not set in .env — the app will not be able to call Claude.\n');
} else if (provider === 'ollama') {
  const model = process.env.OLLAMA_MODEL || 'llama3.2';
  const base = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
  console.log(`[Ollama] Using model "${model}" at ${base}`);
  console.log('[Ollama] Make sure Ollama is running and the model is pulled (ollama pull ' + model + ')\n');
}

app.listen(PORT, () => {
  console.log(`\nWriter Assistant running at http://localhost:${PORT}\n`);
});
