const express = require('express');
const path = require('path');
const fs = require('fs');
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');

const app = express();
const PORT = process.env.PORT || 3000;
const CONFIG_FILE = path.join(__dirname, 'config.json');

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// In-memory credentials storage
let currentConfig = {
  user: process.env.GMAIL_USER || '',
  pass: process.env.GMAIL_APP_PASSWORD || '',
  host: process.env.IMAP_HOST || 'imap.gmail.com',
  port: parseInt(process.env.IMAP_PORT || '993', 10),
  secure: true
};

let connectionState = {
  status: (currentConfig.user && currentConfig.pass) ? 'configured' : 'not_configured',
  lastChecked: null,
  lastError: null
};

// Load saved config on startup if available
try {
  if (fs.existsSync(CONFIG_FILE)) {
    const saved = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
    if (saved && saved.user && saved.pass) {
      currentConfig = {
        user: saved.user || '',
        pass: saved.pass || '',
        host: saved.host || 'imap.gmail.com',
        port: parseInt(saved.port || '993', 10),
        secure: saved.secure !== undefined ? saved.secure : true
      };
      connectionState.status = 'configured';
      console.log(`[Config] Loaded saved credentials for: ${currentConfig.user}`);
    }
  }
} catch (e) {
  console.warn('[Config] Could not load config.json:', e.message);
}

// Helper: friendly error messages for IMAP
function formatImapError(err, host, port) {
  const msg = err.message || '';
  if (err.authenticationFailed || msg.includes('AUTHENTICATIONFAILED') || msg.includes('Invalid credentials')) {
    return 'Gmail Authentication Failed. Google requires a 16-character "App Password" to access Gmail via IMAP. Please ensure 2-Step Verification is active on your Google Account and generate an App Password at https://myaccount.google.com/apppasswords. Your regular Google account password will not work.';
  }
  if (err.code === 'ETIMEDOUT' || msg.toLowerCase().includes('timeout')) {
    return `Connection timed out connecting to ${host}:${port}. Please verify the IMAP host and port (default is imap.gmail.com:993).`;
  }
  if (err.code === 'ENOTFOUND') {
    return `Server host "${host}" could not be resolved. Please check your internet connection or host spelling.`;
  }
  if (err.code === 'ECONNREFUSED') {
    return `Connection refused by ${host}:${port}. Please check if the port is correct.`;
  }
  return msg || 'An unknown IMAP error occurred.';
}

// Helper: Test IMAP connection
async function testImapConnection(cfg) {
  const client = new ImapFlow({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: {
      user: cfg.user,
      pass: cfg.pass
    },
    logger: false,
    connectionTimeout: 12000,
    greetingTimeout: 10000
  });

  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    const totalCount = client.mailbox.exists || 0;
    lock.release();
    await client.logout();
    return {
      success: true,
      message: `Connected successfully! Found ${totalCount} message(s) in INBOX.`
    };
  } catch (err) {
    const friendlyError = formatImapError(err, cfg.host, cfg.port);
    return {
      success: false,
      error: friendlyError,
      raw: err.message
    };
  }
}

// Helper: Detect sender service / brand for SMS-style badge
function detectService(fromText, fromAddress, subject) {
  const combined = `${fromText || ''} ${fromAddress || ''} ${subject || ''}`.toLowerCase();
  if (combined.includes('google') || combined.includes('gmail')) return { name: 'Google', bg: 'bg-red-50 text-red-700 border-red-200', icon: 'G' };
  if (combined.includes('telegram')) return { name: 'Telegram', bg: 'bg-sky-50 text-sky-700 border-sky-200', icon: 'TG' };
  if (combined.includes('whatsapp')) return { name: 'WhatsApp', bg: 'bg-emerald-50 text-emerald-700 border-emerald-200', icon: 'WA' };
  if (combined.includes('facebook') || combined.includes('meta') || combined.includes('instagram')) return { name: 'Meta', bg: 'bg-blue-50 text-blue-700 border-blue-200', icon: 'M' };
  if (combined.includes('microsoft') || combined.includes('outlook') || combined.includes('azure') || combined.includes('live.com')) return { name: 'Microsoft', bg: 'bg-cyan-50 text-cyan-700 border-cyan-200', icon: 'MS' };
  if (combined.includes('apple') || combined.includes('icloud')) return { name: 'Apple', bg: 'bg-slate-100 text-slate-800 border-slate-300', icon: '' };
  if (combined.includes('twitter') || combined.includes(' x ') || combined.includes('x.com')) return { name: 'X / Twitter', bg: 'bg-zinc-100 text-zinc-900 border-zinc-300', icon: '𝕏' };
  if (combined.includes('discord')) return { name: 'Discord', bg: 'bg-indigo-50 text-indigo-700 border-indigo-200', icon: 'DC' };
  if (combined.includes('github')) return { name: 'GitHub', bg: 'bg-gray-100 text-gray-900 border-gray-300', icon: 'GH' };
  if (combined.includes('steam')) return { name: 'Steam', bg: 'bg-slate-800 text-white border-slate-700', icon: 'ST' };
  if (combined.includes('amazon')) return { name: 'Amazon', bg: 'bg-amber-50 text-amber-800 border-amber-300', icon: 'AZ' };
  if (combined.includes('netflix')) return { name: 'Netflix', bg: 'bg-rose-50 text-rose-700 border-rose-200', icon: 'NF' };
  if (combined.includes('stripe')) return { name: 'Stripe', bg: 'bg-purple-50 text-purple-700 border-purple-200', icon: 'SP' };
  if (combined.includes('uber')) return { name: 'Uber', bg: 'bg-zinc-900 text-white border-zinc-800', icon: 'UB' };
  if (combined.includes('paypal')) return { name: 'PayPal', bg: 'bg-blue-50 text-blue-800 border-blue-300', icon: 'PP' };
  if (combined.includes('tiktok')) return { name: 'TikTok', bg: 'bg-neutral-900 text-pink-400 border-neutral-700', icon: 'TT' };

  // Fallback: extract clean name from fromText
  const cleanName = (fromText || 'Service').replace(/<.*?>/, '').replace(/["']/g, '').trim().slice(0, 24) || 'Service';
  const initials = cleanName.slice(0, 2).toUpperCase() || 'SMS';
  return { name: cleanName, bg: 'bg-slate-100 text-slate-700 border-slate-200', icon: initials };
}

// Helper: Extract OTP/Verification code candidates from email text and subject
function extractOtp(text, subject) {
  const combined = `${subject || ''}\n${text || ''}`;

  // 1. Google style verification code: G-123456
  const gMatch = combined.match(/\b(G-[0-9]{6})\b/i);
  if (gMatch && gMatch[1]) return gMatch[1].toUpperCase();

  // 2. Explicit keyword patterns (verification code is 123456, OTP: 1234, etc.)
  const keywordMatch = combined.match(/(?:verification\s*code|security\s*code|confirmation\s*code|login\s*code|access\s*code|passcode|one-time\s*password|otp|pin|código|kod)\s*(?:is|:|-|=|\s)\s*([0-9]{4,8})\b/i);
  if (keywordMatch && keywordMatch[1]) {
    return keywordMatch[1];
  }

  // 3. Keyword followed shortly by 3-3 spaced number (e.g. 123 456 or 123-456)
  const splitMatch = combined.match(/(?:verification|security|confirmation|login|code|otp|pin)\D{0,20}([0-9]{3})[\s-]([0-9]{3})\b/i);
  if (splitMatch && splitMatch[1] && splitMatch[2]) {
    return `${splitMatch[1]}${splitMatch[2]}`;
  }

  // 4. Standard 6-digit standalone numbers
  const sixDigitMatch = combined.match(/\b([0-9]{6})\b/);
  if (sixDigitMatch && sixDigitMatch[1]) {
    return sixDigitMatch[1];
  }

  // 5. 4 to 8 digit standalone numbers
  const anyDigitMatch = combined.match(/\b([0-9]{4,8})\b/);
  if (anyDigitMatch && anyDigitMatch[1]) {
    return anyDigitMatch[1];
  }

  return null;
}

// Helper: Fetch latest emails using ImapFlow + mailparser (with optional time filter)
async function fetchLatestEmails(limit = 10, sinceTimestamp = null) {
  if (!currentConfig.user || !currentConfig.pass) {
    throw new Error('IMAP credentials not configured. Please configure your Gmail account at /admin.');
  }

  const client = new ImapFlow({
    host: currentConfig.host,
    port: currentConfig.port,
    secure: currentConfig.secure,
    auth: {
      user: currentConfig.user,
      pass: currentConfig.pass
    },
    logger: false,
    connectionTimeout: 15000,
    greetingTimeout: 12000
  });

  await client.connect();
  const lock = await client.getMailboxLock('INBOX');
  const emails = [];

  try {
    const total = client.mailbox.exists || 0;

    if (total > 0) {
      // When time-filtering, check a larger window of recent messages (up to 25)
      const fetchCount = sinceTimestamp ? Math.max(limit, 25) : limit;
      const startSeq = Math.max(1, total - fetchCount + 1);
      const range = `${startSeq}:${total}`;

      const rawMessages = [];
      // Fetch source and metadata
      for await (const message of client.fetch(range, { envelope: true, source: true, internalDate: true, uid: true })) {
        rawMessages.push(message);
      }

      // Newest messages first
      rawMessages.reverse();

      const cutoffMs = sinceTimestamp ? (Number(sinceTimestamp) - 5000) : null;

      for (const msg of rawMessages) {
        try {
          const parsed = await simpleParser(msg.source);
          const emailDate = parsed.date ? new Date(parsed.date) : (msg.internalDate ? new Date(msg.internalDate) : new Date());
          const emailTimeMs = emailDate.getTime();

          // If filtering by timestamp, discard emails received prior to the cutoff
          if (cutoffMs && emailTimeMs < cutoffMs) {
            continue;
          }

          const fromText = parsed.from ? (parsed.from.text || parsed.from.value?.[0]?.name || parsed.from.value?.[0]?.address || 'Unknown') : (msg.envelope?.from?.[0]?.name || msg.envelope?.from?.[0]?.address || 'Unknown');
          const fromAddress = parsed.from?.value?.[0]?.address || msg.envelope?.from?.[0]?.address || '';
          const subject = parsed.subject || msg.envelope?.subject || '(No Subject)';
          const date = emailDate.toISOString();
          const bodyText = (parsed.text || '').trim();
          const snippet = bodyText ? bodyText.slice(0, 220).replace(/\s+/g, ' ') : (parsed.html ? 'Contains HTML formatted content' : '(Empty body)');
          const detectedOtp = extractOtp(bodyText, subject);
          const service = detectService(fromText, fromAddress, subject);

          emails.push({
            uid: msg.uid,
            seq: msg.seq,
            from: fromText,
            fromAddress: fromAddress,
            service: service,
            to: parsed.to?.text || '',
            subject: subject,
            date: date,
            timestampMs: emailTimeMs,
            otp: detectedOtp,
            snippet: snippet,
            bodyText: bodyText || snippet,
            hasHtml: Boolean(parsed.html),
            html: parsed.html || null
          });

          // Respect requested limit
          if (!sinceTimestamp && emails.length >= limit) {
            break;
          }
        } catch (parseErr) {
          const fallbackDate = msg.internalDate ? new Date(msg.internalDate) : new Date();
          const fallbackTimeMs = fallbackDate.getTime();

          if (cutoffMs && fallbackTimeMs < cutoffMs) {
            continue;
          }

          const sub = msg.envelope?.subject || '(No Subject)';
          const fromName = msg.envelope?.from?.[0]?.name || msg.envelope?.from?.[0]?.address || 'Unknown';
          const fromAddr = msg.envelope?.from?.[0]?.address || '';
          const detectedOtp = extractOtp('', sub);
          const service = detectService(fromName, fromAddr, sub);

          emails.push({
            uid: msg.uid,
            seq: msg.seq,
            from: fromName,
            fromAddress: fromAddr,
            service: service,
            to: '',
            subject: sub,
            date: fallbackDate.toISOString(),
            timestampMs: fallbackTimeMs,
            otp: detectedOtp,
            snippet: '(Unable to parse message body)',
            bodyText: '(Parse error)',
            hasHtml: false,
            html: null
          });

          if (!sinceTimestamp && emails.length >= limit) {
            break;
          }
        }
      }
    }
  } finally {
    lock.release();
  }

  await client.logout();
  return emails;
}

// ---------------- API Routes ----------------

// GET /api/config: Return current config status
app.get('/api/config', (req, res) => {
  const isConfigured = Boolean(currentConfig.user && currentConfig.pass);
  res.json({
    configured: isConfigured,
    user: currentConfig.user,
    host: currentConfig.host,
    port: currentConfig.port,
    secure: currentConfig.secure,
    status: connectionState.status,
    lastChecked: connectionState.lastChecked,
    lastError: connectionState.lastError
  });
});

// POST /api/config: Save credentials & test connection
app.post('/api/config', async (req, res) => {
  try {
    const { user, pass, host, port, secure } = req.body;

    if (!user || !user.trim()) {
      return res.status(400).json({ success: false, error: 'Gmail address is required.' });
    }

    if (!pass || !pass.trim()) {
      return res.status(400).json({ success: false, error: 'Gmail App Password is required.' });
    }

    const cleanUser = user.trim();
    // Remove all spaces commonly included in Google 16-character App Passwords
    const cleanPass = pass.replace(/\s+/g, '');
    const cleanHost = (host && host.trim()) ? host.trim() : 'imap.gmail.com';
    const cleanPort = port ? parseInt(port, 10) : 993;
    const isSecure = secure !== undefined ? Boolean(secure) : (cleanPort === 993 || cleanPort === 465);

    const testCfg = {
      user: cleanUser,
      pass: cleanPass,
      host: cleanHost,
      port: cleanPort,
      secure: isSecure
    };

    console.log(`[Config] Testing connection for ${cleanUser} at ${cleanHost}:${cleanPort}...`);
    const testResult = await testImapConnection(testCfg);

    if (testResult.success) {
      currentConfig = testCfg;
      connectionState = {
        status: 'connected',
        lastChecked: new Date().toISOString(),
        lastError: null
      };

      // Persist to config.json
      try {
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(currentConfig, null, 2), 'utf-8');
      } catch (err) {
        console.warn('[Config] Could not save config.json:', err.message);
      }

      return res.json({
        success: true,
        status: 'connected',
        message: testResult.message,
        user: currentConfig.user,
        host: currentConfig.host,
        port: currentConfig.port
      });
    } else {
      connectionState = {
        status: 'failed',
        lastChecked: new Date().toISOString(),
        lastError: testResult.error
      };

      return res.status(400).json({
        success: false,
        status: 'failed',
        error: testResult.error,
        raw: testResult.raw
      });
    }
  } catch (err) {
    console.error('[Config] Error handling config:', err);
    connectionState = {
      status: 'failed',
      lastChecked: new Date().toISOString(),
      lastError: err.message
    };
    return res.status(500).json({
      success: false,
      status: 'failed',
      error: err.message || 'Server error occurred during connection test.'
    });
  }
});

// POST /api/test-connection: Re-test current saved connection
app.post('/api/test-connection', async (req, res) => {
  if (!currentConfig.user || !currentConfig.pass) {
    return res.status(400).json({
      success: false,
      status: 'not_configured',
      error: 'No credentials configured yet. Please enter your Gmail address and App Password.'
    });
  }

  const result = await testImapConnection(currentConfig);
  connectionState.lastChecked = new Date().toISOString();

  if (result.success) {
    connectionState.status = 'connected';
    connectionState.lastError = null;
    return res.json({ success: true, status: 'connected', message: result.message });
  } else {
    connectionState.status = 'failed';
    connectionState.lastError = result.error;
    return res.status(400).json({ success: false, status: 'failed', error: result.error });
  }
});

// POST /api/disconnect: Clear credentials
app.post('/api/disconnect', (req, res) => {
  currentConfig = {
    user: '',
    pass: '',
    host: 'imap.gmail.com',
    port: 993,
    secure: true
  };
  connectionState = {
    status: 'not_configured',
    lastChecked: new Date().toISOString(),
    lastError: null
  };

  try {
    if (fs.existsSync(CONFIG_FILE)) {
      fs.unlinkSync(CONFIG_FILE);
    }
  } catch (e) {
    console.warn('Failed to delete config.json:', e.message);
  }

  res.json({ success: true, message: 'Disconnected and credentials cleared.' });
});

// GET /api/emails: Fetch latest 10 emails
app.get('/api/emails', async (req, res) => {
  if (!currentConfig.user || !currentConfig.pass) {
    return res.status(400).json({
      success: false,
      configured: false,
      error: 'IMAP credentials not configured. Please go to the Configuration page (/admin) to enter your Gmail credentials.'
    });
  }

  try {
    const limit = parseInt(req.query.limit, 10) || 10;
    const since = req.query.since ? parseInt(req.query.since, 10) : null;
    
    if (since) {
      console.log(`[IMAP] Live Catch: Fetching new emails since ${new Date(since).toISOString()} (${since}) for ${currentConfig.user}...`);
    } else {
      console.log(`[IMAP] Fetching latest ${limit} emails for ${currentConfig.user}...`);
    }

    const emails = await fetchLatestEmails(limit, since);
    connectionState.status = 'connected';
    connectionState.lastChecked = new Date().toISOString();
    connectionState.lastError = null;

    res.json({
      success: true,
      count: emails.length,
      user: currentConfig.user,
      host: currentConfig.host,
      since: since || null,
      serverTime: Date.now(),
      emails
    });
  } catch (err) {
    console.error('[IMAP] Failed to fetch emails:', err);
    const friendlyError = formatImapError(err, currentConfig.host, currentConfig.port);
    connectionState.status = 'failed';
    connectionState.lastChecked = new Date().toISOString();
    connectionState.lastError = friendlyError;

    res.status(500).json({
      success: false,
      error: friendlyError,
      raw: err.message
    });
  }
});

// ---------------- Page Routes ----------------

// Page 1: Admin Configuration Page (/admin)
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Page 2: Inbox / Live Mail Page (/)
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Catch-all 404
app.use((req, res) => {
  res.status(404).send('Page not found. <a href="/">Go to Inbox</a> or <a href="/admin">Go to Admin</a>');
});

// Start Express server on dynamic port for hosting platforms
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
  console.log(`- Inbox Page: http://localhost:${PORT}/`);
  console.log(`- Admin Page: http://localhost:${PORT}/admin`);
});
