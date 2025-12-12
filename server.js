/**
 * bot-server.js
 *
 * Telegram webhook-mode bot server + callback receiver for resume-ready events.
 *
 * Usage:
 *  - install: npm install express axios node-telegram-bot-api helmet morgan dotenv
 *  - env variables required:
 *      TELEGRAM_BOT_TOKEN          Telegram bot token (botfather)
 *      TELEGRAM_WEBHOOK_SECRET    (optional) secret token when setting webhook
 *      PUBLIC_URL                 Public HTTPS URL for this server (e.g. https://bot.example.com)
 *      BACKEND_URL                URL of your resume backend (e.g. https://backend.example.com)
 *      BACKEND_SECRET             Shared secret header value for backend->bot calls (x-api-key)
 *      PORT                       Port to listen on (default 3000)
 *
 *  - to register webhook (one-time, after server is reachable):
 *      curl "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook?url=<PUBLIC_URL>/tg-webhook&secret_token=<TELEGRAM_WEBHOOK_SECRET>"
 *
 *  - Backend should call POST <PUBLIC_URL>/resume-ready with header "x-api-key: BACKEND_SECRET"
 *    Example JSON payload backend -> bot:
 *    {
 *       "userId": 532287234,
 *       "tg_pdf_id": "AgACAgUAAxkBAA...",           // optional - prefer this
 *       "pdf_url": "https://...",                   // optional fallback
 *       "hrEmail": "hr@company.com",
 *       "meta": { "jobTitle": "...", "jobUrl": "..." }
 *    }
 *
 *  - Bot will reply immediately to user on receiving JD, forward JD to backend:
 *    POST BACKEND_URL/apply with JSON: { userId, jd } and header x-api-key
 *    Expect backend to accept and kick off job asynchronously.
 *
 *  - This server does NOT store data persistently — DB or history is assumed to be in your backend.
 *
 * NOTE: This server expects to be reachable at PUBLIC_URL and served over HTTPS (Telegram requires HTTPS).
 */

require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const morgan = require('morgan');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const TelegramBot = require('node-telegram-bot-api');

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET || '';
const PUBLIC_URL = process.env.PUBLIC_URL; // e.g. https://bot.example.com
const BACKEND_URL = process.env.BACKEND_URL; // e.g. https://backend.example.com
const BACKEND_SECRET = process.env.BACKEND_SECRET; // shared secret for backend->bot calls (x-api-key)
const PORT = process.env.PORT || 3000;

if (!TELEGRAM_BOT_TOKEN) {
  console.error("Missing TELEGRAM_BOT_TOKEN in env.");
  process.exit(1);
}
if (!PUBLIC_URL) {
  console.error("Missing PUBLIC_URL in env (public HTTPS URL for webhook).");
  process.exit(1);
}
if (!BACKEND_URL) {
  console.error("Missing BACKEND_URL in env (resume backend endpoint).");
  process.exit(1);
}
if (!BACKEND_SECRET) {
  console.error("Missing BACKEND_SECRET in env (shared secret between backend and bot).");
  process.exit(1);
}

// Create Telegram bot instance (no polling)
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: false });

// Optionally set webhook programmatically on startup (idempotent).
async function ensureWebhook() {
  try {
    const webhookUrl = `${PUBLIC_URL.replace(/\/$/, '')}/tg-webhook`;
    const setHookUrl = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook`;
    const params = new URLSearchParams();
    params.append('url', webhookUrl);
    // Add secret_token if provided - Telegram sends header X-Telegram-Bot-Api-Secret-Token to your webhook.
    if (TELEGRAM_WEBHOOK_SECRET) params.append('secret_token', TELEGRAM_WEBHOOK_SECRET);

    const url = `${setHookUrl}?${params.toString()}`;
    const res = await axios.get(url);
    if (res.data && res.data.ok) {
      console.log('Webhook registered:', webhookUrl);
    } else {
      console.warn('Webhook registration response:', res.data);
    }
  } catch (err) {
    console.error('Failed to set webhook automatically:', err.message || err);
    // Not fatal: user can register webhook manually
  }
}

const app = express();
app.use(helmet());
app.use(morgan('combined'));
app.use(express.json({ limit: '1mb' })); // incoming JSON body limit
app.use(express.urlencoded({ extended: false }));

// Health check
app.get('/health', (req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

/**
 * Telegram webhook endpoint
 * Telegram will POST updates here (messages, callbacks, etc).
 * We verify the optional secret token header: 'x-telegram-bot-api-secret-token'
 */
app.post('/tg-webhook', (req, res) => {
  try {
    // Optional verification of secret token header
    if (TELEGRAM_WEBHOOK_SECRET) {
      const secretHeader = req.get('x-telegram-bot-api-secret-token') || '';
      if (!secretHeader || secretHeader !== TELEGRAM_WEBHOOK_SECRET) {
        console.warn('Invalid telegram webhook secret token from', req.ip);
        return res.sendStatus(401);
      }
    }

    // Pass the update JSON into node-telegram-bot-api for processing
    bot.processUpdate(req.body);

    // Respond quickly (200 OK)
    res.sendStatus(200);
  } catch (err) {
    console.error('Error processing /tg-webhook:', err);
    res.sendStatus(500);
  }
});

/**
 * Primary message handler (node-telegram-bot-api event)
 *
 * We accept:
 *  - plain text messages (treated as JD)
 *  - commands like /apply <JD>
 *
 * Behavior:
 *  - Immediately acknowledge to user (fast)
 *  - Forward JD to backend asynchronously (non-blocking)
 */
bot.on('message', async (msg) => {
  try {
    // Basic guards
    if (!msg || !msg.from || !msg.chat) return;
    const chatId = msg.chat.id;
    const userId = msg.from.id; // Telegram user id (use as auth identity)
    const username = msg.from.username || '';
    const text = (msg.text || '').trim();

    if (!text) {
      // ignore non-text messages for now, or respond with instruction
      await bot.sendMessage(chatId, 'Please send the Job Description text (paste JD or use /apply <JD>).');
      return;
    }

    // Support slash command: /apply <jd>
    let jdText = text;
    if (text.startsWith('/apply')) {
      jdText = text.replace('/apply', '').trim();
      if (!jdText) {
        await bot.sendMessage(chatId, 'Usage: /apply <paste the job description here>');
        return;
      }
    }

    // Immediate acknowledgement (short message)
    await bot.sendMessage(chatId,
      '✅ Received the Job Description. Generating an ATS-optimized resume — this may take ~20–40 seconds. I will send it here once ready.');

    // Forward JD to backend (non-blocking)
    // Backend expects: { userId, jd } and header 'x-api-key'
    (async () => {
      try {
        const payload = {
          userId,
          jd: jdText,
          meta: {
            username,
            chatId
          }
        };
        const resp = await axios.post(
          `${BACKEND_URL.replace(/\/$/, '')}/apply`,
          payload,
          {
            headers: {
              'Content-Type': 'application/json',
              'x-api-key': BACKEND_SECRET
            },
            timeout: 10_000 // 10s for initial ack - backend should respond quickly with job accepted
          }
        );

        // Optional: inform user backend accepted the job (kept minimal to avoid spamming)
        if (resp && resp.data && resp.data.jobId) {
          // You may want to store jobId mapping locally if needed (not required if backend handles user mapping).
          console.log('Backend accepted job', resp.data.jobId, 'for user', userId);
        } else {
          console.log('Backend response (no jobId) for user', userId, resp.data);
        }
      } catch (err) {
        console.error('Error sending JD to backend:', err.message || err);
        try {
          await bot.sendMessage(chatId,
            '⚠️ Failed to submit the job to the backend. Please try again later.');
        } catch (e) { /* ignore */ }
      }
    })();

  } catch (err) {
    console.error('Error in message handler:', err);
  }
});

/**
 * Backend -> Bot callback webhook
 * Endpoint the backend calls once resume is ready (or failed).
 * This IS a webhook (backend pushes job result to bot).
 *
 * Security: require 'x-api-key' header = BACKEND_SECRET
 *
 * Expected POST payload (example):
 * {
 *   userId: 532287234,
 *   tg_pdf_id: "AgACAgUAAxkBAA...",    // OPTIONAL - prefer this
 *   tg_latex_id: "AgACAgUAAxkBAA...",  // OPTIONAL
 *   pdf_url: "https://....",           // OPTIONAL fallback if no tg_pdf_id
 *   hrEmail: "hr@company.com",
 *   jobId: "abc123",
 *   status: "completed"  // or "failed"
 * }
 */
app.post('/resume-ready', async (req, res) => {
  try {
    const key = req.get('x-api-key') || '';
    if (!key || key !== BACKEND_SECRET) {
      console.warn('Unauthorized resume-ready call from', req.ip);
      return res.sendStatus(403);
    }

    const body = req.body || {};
    const userId = body.userId;
    const tgPdfId = body.tg_pdf_id || body.tg_pdf_id === 0 ? body.tg_pdf_id : null;
    const pdfUrl = body.pdf_url || null;
    const hrEmail = body.hrEmail || body.hr_contact || null;
    const status = body.status || 'completed';
    const jobId = body.jobId || null;

    if (!userId) {
      console.warn('resume-ready missing userId');
      return res.status(400).json({ error: 'missing userId' });
    }

    // If backend reports failure
    if (status !== 'completed') {
      await bot.sendMessage(userId,
        `❌ Resume generation failed for job ${jobId || ''}. Please try again or contact support.`);
      return res.json({ ok: true });
    }

    // Prefer Telegram file_id (no download/upload)
    try {
      if (tgPdfId) {
        // send by file_id
        await bot.sendDocument(userId, tgPdfId, {
          caption: hrEmail ? `Your resume (HR Contact: ${hrEmail})` : 'Your resume (generated).'
        });
      } else if (pdfUrl) {
        // send by URL (Telegram will fetch the URL)
        await bot.sendDocument(userId, pdfUrl, {
          caption: hrEmail ? `Your resume (HR Contact: ${hrEmail})` : 'Your resume (generated).'
        });
      } else {
        // No file provided
        await bot.sendMessage(userId, '⚠️ Backend reported completion but did not provide a file.');
        console.warn('resume-ready missing file for user', userId, 'payload:', body);
      }

      // Send HR email separately if present (for visibility/searchable message)
      if (hrEmail) {
        await bot.sendMessage(userId, `🔎 HR Contact found: ${hrEmail}`);
      }

      // Optionally send a small confirmation message with job id or link
      if (jobId) {
        await bot.sendMessage(userId, `Job ID: ${jobId}`);
      }

      return res.json({ ok: true });
    } catch (err) {
      console.error('Error sending document to user', userId, err);
      // Try to notify user about failure
      try {
        await bot.sendMessage(userId,
          '⚠️ Failed to send generated resume to your chat. The team has been notified.');
      } catch (e) { /* ignore */ }
      return res.status(500).json({ error: 'failed to deliver resume' });
    }

  } catch (err) {
    console.error('Error in /resume-ready:', err);
    return res.status(500).json({ error: 'internal error' });
  }
});

/**
 * Optional: endpoint to let admin re-send / download a file by file_id (for testing)
 */
app.post('/admin/resend', async (req, res) => {
  // Simple security: require BACKEND_SECRET (or a separate ADMIN_SECRET)
  const key = req.get('x-api-key') || '';
  if (!key || key !== BACKEND_SECRET) return res.sendStatus(403);

  const { userId, tgPdfId, pdfUrl, caption } = req.body || {};
  if (!userId) return res.status(400).json({ error: 'missing userId' });

  try {
    if (tgPdfId) {
      await bot.sendDocument(userId, tgPdfId, { caption: caption || 'Resent resume' });
    } else if (pdfUrl) {
      await bot.sendDocument(userId, pdfUrl, { caption: caption || 'Resent resume' });
    } else {
      return res.status(400).json({ error: 'no file provided' });
    }
    return res.json({ ok: true });
  } catch (err) {
    console.error('admin resend error', err);
    return res.status(500).json({ error: 'failed' });
  }
});

// Start server & ensure webhook registration
app.listen(PORT, async () => {
  console.log(`Bot server listening on port ${PORT}`);
  await ensureWebhook();
});
