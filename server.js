const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const db = require('./db');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Helper: Friendly error messages for IMAP
function formatImapError(err, host = 'imap.gmail.com', port = 993) {
  const msg = err.message || '';
  if (err.authenticationFailed || msg.includes('AUTHENTICATIONFAILED') || msg.includes('Invalid credentials')) {
    return 'Gmail Authentication Failed. Google requires a 16-character "App Password" to access Gmail via IMAP. Please ensure 2-Step Verification is active on your Google Account and generate an App Password at https://myaccount.google.com/apppasswords. Regular account passwords will not work.';
  }
  if (err.code === 'ETIMEDOUT' || msg.toLowerCase().includes('timeout')) {
    return `Connection timed out connecting to ${host}:${port}. Please verify your network and port.`;
  }
  if (err.code === 'ENOTFOUND') {
    return `Server host "${host}" could not be resolved. Please check host spelling.`;
  }
  if (err.code === 'ECONNREFUSED') {
    return `Connection refused by ${host}:${port}.`;
  }
  return msg || 'An unknown IMAP error occurred.';
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

  const cleanName = (fromText || 'Service').replace(/<.*?>/, '').replace(/["']/g, '').trim().slice(0, 24) || 'Service';
  const initials = cleanName.slice(0, 2).toUpperCase() || 'EM';
  return { name: cleanName, bg: 'bg-slate-100 text-slate-700 border-slate-200', icon: initials };
}

// Helper: Extract OTP/Verification code candidates from email text and subject
function extractOtp(text, subject) {
  const combined = `${subject || ''}\n${text || ''}`;

  // 1. Google style verification code: G-123456
  const gMatch = combined.match(/\b(G-[0-9]{6})\b/i);
  if (gMatch && gMatch[1]) return gMatch[1].toUpperCase();

  // 2. Explicit keyword patterns
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

// Helper: Parse ImapFlow message into structured email object
async function parseMessageToEmail(msg, fallbackAccountEmail) {
  try {
    const parsed = await simpleParser(msg.source);
    const emailDate = parsed.date ? new Date(parsed.date) : (msg.internalDate ? new Date(msg.internalDate) : new Date());
    const emailTimeMs = emailDate.getTime();

    const fromText = parsed.from ? (parsed.from.text || parsed.from.value?.[0]?.name || parsed.from.value?.[0]?.address || 'Unknown') : (msg.envelope?.from?.[0]?.name || msg.envelope?.from?.[0]?.address || 'Unknown');
    const fromAddress = parsed.from?.value?.[0]?.address || msg.envelope?.from?.[0]?.address || '';
    const toAddress = parsed.to?.text || msg.envelope?.to?.[0]?.address || fallbackAccountEmail;
    const subject = parsed.subject || msg.envelope?.subject || '(No Subject)';
    const date = emailDate.toISOString();
    const bodyText = (parsed.text || '').trim();
    const snippet = bodyText ? bodyText.slice(0, 240).replace(/\s+/g, ' ') : (parsed.html ? 'Contains HTML formatted content' : '(Empty body)');
    const detectedOtp = extractOtp(bodyText, subject);
    const service = detectService(fromText, fromAddress, subject);

    return {
      uid: msg.uid,
      seq: msg.seq,
      from: fromText,
      fromAddress: fromAddress,
      service: service,
      to: toAddress,
      subject: subject,
      date: date,
      timestampMs: emailTimeMs,
      otp: detectedOtp,
      snippet: snippet,
      bodyText: bodyText || snippet,
      hasHtml: Boolean(parsed.html),
      html: parsed.html || null
    };
  } catch (parseErr) {
    const fallbackDate = msg.internalDate ? new Date(msg.internalDate) : new Date();
    const fallbackTimeMs = fallbackDate.getTime();
    const sub = msg.envelope?.subject || '(No Subject)';
    const fromName = msg.envelope?.from?.[0]?.name || msg.envelope?.from?.[0]?.address || 'Unknown';
    const fromAddr = msg.envelope?.from?.[0]?.address || '';
    const detectedOtp = extractOtp('', sub);
    const service = detectService(fromName, fromAddr, sub);

    return {
      uid: msg.uid,
      seq: msg.seq,
      from: fromName,
      fromAddress: fromAddr,
      service: service,
      to: msg.envelope?.to?.[0]?.address || fallbackAccountEmail,
      subject: sub,
      date: fallbackDate.toISOString(),
      timestampMs: fallbackTimeMs,
      otp: detectedOtp,
      snippet: '(Unable to parse message body)',
      bodyText: '(Unable to parse body content)',
      hasHtml: false,
      html: null
    };
  }
}

// Single account test
async function testSingleAccount(email, appPassword, host = 'imap.gmail.com', port = 993, secure = true) {
  const client = new ImapFlow({
    host,
    port,
    secure,
    auth: { user: email, pass: appPassword },
    logger: false,
    connectionTimeout: 10000,
    greetingTimeout: 8000
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
    const friendlyError = formatImapError(err, host, port);
    return {
      success: false,
      error: friendlyError,
      raw: err.message
    };
  }
}

// ================= REAL-TIME WEBSOCKET & IMAPFLOW IDLE =================
// Map of active watchers per socket: socket.id -> { client, emailId, accountEmail, isClosing }
const activeSocketWatchers = new Map();

/**
 * Stop watching an account for a given socket cleanly.
 * Logout / close connection to free all resources and prevent memory leaks.
 */
async function stopWatching(socketId) {
  const watcher = activeSocketWatchers.get(socketId);
  if (!watcher) return;

  activeSocketWatchers.delete(socketId);
  watcher.isClosing = true;

  try {
    console.log(`[IDLE] Stopping watcher for socket ${socketId} (${watcher.accountEmail})`);
    if (watcher.client) {
      watcher.client.removeAllListeners('exists');
      watcher.client.removeAllListeners('error');
      watcher.client.removeAllListeners('close');

      try {
        await watcher.client.logout();
      } catch (logoutErr) {
        try {
          watcher.client.close();
        } catch (closeErr) {}
      }
    }
  } catch (err) {
    console.warn(`[IDLE] Error during watcher cleanup for socket ${socketId}:`, err.message);
  }
}

/**
 * Start real-time IMAP IDLE watcher for a client socket.
 * When client emits 'watch-inbox', we:
 * 1) Connect to the chosen Gmail account via ImapFlow
 * 2) Open INBOX and activate IDLE (listen())
 * 3) Listen for 'exists' event
 * 4) When a new email arrives, fetch, parse with mailparser, extract OTP, and emit 'new-email'
 */
async function startWatching(socket, emailId) {
  // Always stop previous watcher for this socket first
  await stopWatching(socket.id);

  const acc = db.findById(emailId, true);
  if (!acc) {
    socket.emit('watch-status', {
      success: false,
      error: 'Requested account not found in database pool'
    });
    return;
  }

  const watcherState = {
    client: null,
    emailId: acc.id,
    accountEmail: acc.email,
    isClosing: false,
    lastKnownExists: 0
  };

  activeSocketWatchers.set(socket.id, watcherState);
  db.recordUsage(acc.id);

  console.log(`[IDLE] Initializing real-time IMAP watcher for ${acc.email} (socket: ${socket.id})...`);

  socket.emit('watch-status', {
    success: true,
    status: 'connecting',
    email: acc.email,
    message: `Connecting to ${acc.email}...`
  });

  const client = new ImapFlow({
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: {
      user: acc.email,
      pass: acc.appPassword
    },
    logger: false,
    connectionTimeout: 15000,
    greetingTimeout: 12000
  });

  // Provide explicit client.listen() wrapper adhering to requirement
  if (!client.listen) {
    client.listen = async function() {
      // Ensure mailbox is open and autoidle is engaged
      if (this.mailbox && typeof this.autoidle === 'function') {
        this.autoidle();
      }
    };
  }

  watcherState.client = client;

  client.on('error', (err) => {
    if (watcherState.isClosing) return;
    console.error(`[IDLE Error] Account ${acc.email} on socket ${socket.id}:`, err.message);
    const friendly = formatImapError(err, 'imap.gmail.com', 993);
    socket.emit('watch-error', { error: friendly });
  });

  client.on('close', () => {
    if (watcherState.isClosing) return;
    console.log(`[IDLE Close] Connection closed for ${acc.email} (socket ${socket.id})`);
    socket.emit('watch-status', {
      success: false,
      status: 'disconnected',
      message: 'IMAP connection closed.'
    });
  });

  // Real-time notification when a new message arrives in INBOX
  client.on('exists', async (data) => {
    if (watcherState.isClosing) return;
    const currentCount = data.count || (client.mailbox ? client.mailbox.exists : 0);
    const prevCount = data.prevCount || watcherState.lastKnownExists || 0;
    watcherState.lastKnownExists = currentCount;

    console.log(`[IDLE 'exists'] Event fired for ${acc.email}: count=${currentCount}, prev=${prevCount}`);

    // If new email was added
    if (currentCount > prevCount || currentCount > 0) {
      try {
        // Fetch the newest arriving message(s)
        const newEmailsCount = prevCount > 0 ? Math.min(5, currentCount - prevCount) : 1;
        const startSeq = Math.max(1, currentCount - newEmailsCount + 1);
        const range = `${startSeq}:${currentCount}`;

        for await (const message of client.fetch(range, { envelope: true, source: true, internalDate: true, uid: true })) {
          const parsedEmail = await parseMessageToEmail(message, acc.email);
          console.log(`[IDLE Push] Emitting 'new-email' to socket ${socket.id} (Subject: "${parsedEmail.subject}", OTP: ${parsedEmail.otp || 'None'})`);
          // Instant Real-Time Push to frontend via Socket.io
          socket.emit('new-email', parsedEmail);
        }
      } catch (fetchErr) {
        console.error(`[IDLE Fetch Error] Failed to fetch newly arrived message for ${acc.email}:`, fetchErr);
      }
    }
  });

  try {
    await client.connect();
    // Open the INBOX
    await client.mailboxOpen('INBOX');
    watcherState.lastKnownExists = client.mailbox ? client.mailbox.exists : 0;

    // Start listening in real time using ImapFlow's IDLE feature
    await client.listen();

    console.log(`[IDLE Ready] Now listening in real-time for ${acc.email} (Current messages: ${watcherState.lastKnownExists})`);

    socket.emit('watch-status', {
      success: true,
      status: 'listening',
      email: acc.email,
      accountId: acc.id,
      mailboxCount: watcherState.lastKnownExists,
      message: `Live Real-Time IDLE Push active for ${acc.email}`
    });

    // Send initial recent messages (if any) received within the last 5 minutes so visitor sees immediate context
    if (watcherState.lastKnownExists > 0) {
      try {
        const fetchCount = Math.min(watcherState.lastKnownExists, 10);
        const startSeq = Math.max(1, watcherState.lastKnownExists - fetchCount + 1);
        const range = `${startSeq}:${watcherState.lastKnownExists}`;
        const initialMessages = [];

        for await (const msg of client.fetch(range, { envelope: true, source: true, internalDate: true, uid: true })) {
          initialMessages.push(msg);
        }

        // Send newest first
        initialMessages.reverse();
        const cutoffMs = Date.now() - (5 * 60 * 1000);
        const parsedInitial = [];

        for (const m of initialMessages) {
          const parsed = await parseMessageToEmail(m, acc.email);
          if (parsed.timestampMs >= cutoffMs) {
            parsedInitial.push(parsed);
          }
        }

        if (parsedInitial.length > 0) {
          socket.emit('initial-emails', {
            email: acc.email,
            emails: parsedInitial
          });
        }
      } catch (initialErr) {
        console.warn(`[IDLE] Initial messages check warning:`, initialErr.message);
      }
    }

  } catch (connErr) {
    console.error(`[IDLE Connect Error] Failed to connect to ${acc.email}:`, connErr);
    const friendly = formatImapError(connErr, 'imap.gmail.com', 993);
    socket.emit('watch-status', {
      success: false,
      status: 'error',
      error: friendly
    });
    await stopWatching(socket.id);
  }
}

// Socket.io Connection Management
io.on('connection', (socket) => {
  console.log(`[Socket.io] Client connected: ${socket.id}`);

  // When frontend selects or views an active email address
  socket.on('watch-inbox', async (payload) => {
    try {
      const emailId = payload ? (payload.emailId || payload.id) : null;
      console.log(`[Socket.io] Received 'watch-inbox' for emailId: ${emailId} from socket: ${socket.id}`);
      if (!emailId) {
        socket.emit('watch-status', { success: false, error: 'No emailId provided' });
        return;
      }
      await startWatching(socket, emailId);
    } catch (err) {
      console.error(`[Socket.io] Error in 'watch-inbox':`, err);
    }
  });

  // Client requests to stop watching
  socket.on('stop-watching', async () => {
    await stopWatching(socket.id);
  });

  // Disconnect cleanup: always close IMAP session cleanly
  socket.on('disconnect', async () => {
    console.log(`[Socket.io] Client disconnected: ${socket.id}`);
    await stopWatching(socket.id);
  });
});

// ================= REST API ROUTES =================

// 1. GET /api/accounts - List all stored accounts with stats
app.get('/api/accounts', (req, res) => {
  const accounts = db.getAll(false);
  const stats = db.getStats();
  res.json({
    success: true,
    total: stats.total,
    active: stats.active,
    inactive: stats.inactive,
    accounts
  });
});

// 2. POST /api/accounts/bulk - Bulk import "email:app_password" lines
app.post('/api/accounts/bulk', (req, res) => {
  const { data } = req.body;
  if (!data || typeof data !== 'string') {
    return res.status(400).json({
      success: false,
      error: 'Expected "data" field containing account lines (email:app_password)'
    });
  }

  const result = db.bulkImport(data);
  res.json({
    success: true,
    message: `Import complete: ${result.added} added, ${result.updated} updated, ${result.skipped} skipped.`,
    ...result
  });
});

// 3. POST /api/accounts - Add single account
app.post('/api/accounts', (req, res) => {
  const { email, appPassword, status } = req.body;
  if (!email || !appPassword) {
    return res.status(400).json({
      success: false,
      error: 'Both email and 16-character Gmail App Password are required'
    });
  }

  try {
    const acc = db.addAccount(email, appPassword, status || 'active');
    res.json({
      success: true,
      account: db.findById(acc.id, false)
    });
  } catch (err) {
    res.status(400).json({
      success: false,
      error: err.message
    });
  }
});

// 4. DELETE /api/accounts/:id - Remove an account
app.delete('/api/accounts/:id', async (req, res) => {
  const { id } = req.params;
  const deleted = db.deleteAccount(id);
  if (!deleted) {
    return res.status(404).json({ success: false, error: 'Account not found' });
  }

  // If any socket is watching this deleted account, close it
  for (const [sockId, watcher] of activeSocketWatchers.entries()) {
    if (String(watcher.emailId) === String(id)) {
      const sock = io.sockets.sockets.get(sockId);
      if (sock) {
        sock.emit('watch-status', { success: false, error: 'Account was removed from the pool' });
      }
      stopWatching(sockId);
    }
  }

  const stats = db.getStats();
  res.json({
    success: true,
    message: 'Account deleted successfully',
    stats
  });
});

// 5. POST /api/accounts/:id/test - Test connection for a specific account
app.post('/api/accounts/:id/test', async (req, res) => {
  const { id } = req.params;
  const acc = db.findById(id, true);
  if (!acc) {
    return res.status(404).json({ success: false, error: 'Account not found' });
  }

  console.log(`[IMAP Test] Testing credentials for ${acc.email}...`);
  const result = await testSingleAccount(acc.email, acc.appPassword);
  db.recordTestResult(id, result.success, result.success ? result.message : result.error);

  res.json({
    success: result.success,
    email: acc.email,
    message: result.message || null,
    error: result.error || null,
    account: db.findById(id, false)
  });
});

// 6. GET /api/assigned - Get currently assigned email or pick next from pool
app.get('/api/assigned', (req, res) => {
  const { currentId } = req.query;
  const poolCount = db.getStats().total;

  if (poolCount === 0) {
    return res.json({
      success: false,
      configured: false,
      message: 'No Gmail accounts available in the database pool. Please visit /admin to import accounts.'
    });
  }

  let acc = null;
  if (currentId) {
    acc = db.findById(currentId, false);
    if (!acc || acc.status !== 'active') {
      acc = db.getActiveAccount();
    }
  } else {
    acc = db.getActiveAccount();
  }

  if (!acc) {
    acc = db.getAll(false)[0];
  }

  if (acc) {
    db.recordUsage(acc.id);
  }

  const pool = db.getAll(false);

  res.json({
    success: true,
    configured: true,
    account: acc,
    poolCount,
    poolList: pool.map(a => ({ id: a.id, email: a.email, status: a.status }))
  });
});

// 7. GET /api/assigned/next - Switch to next random email from pool
app.get('/api/assigned/next', (req, res) => {
  const { currentId } = req.query;
  const poolCount = db.getStats().total;

  if (poolCount === 0) {
    return res.json({
      success: false,
      configured: false,
      message: 'No Gmail accounts available. Please add accounts at /admin.'
    });
  }

  const nextAcc = db.getRandomNext(currentId);
  if (nextAcc) {
    db.recordUsage(nextAcc.id);
  }

  res.json({
    success: true,
    configured: true,
    account: nextAcc ? db.findById(nextAcc.id, false) : null,
    poolCount
  });
});

// Legacy config route for backward compatibility
app.get('/api/config', (req, res) => {
  const stats = db.getStats();
  const configured = stats.total > 0;
  const first = stats.total > 0 ? db.getAll(false)[0] : null;

  res.json({
    configured,
    totalAccounts: stats.total,
    activeAccounts: stats.active,
    user: first ? first.email : '',
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    status: configured ? 'configured' : 'not_configured'
  });
});

// ---------------- Page Routes ----------------

// Admin Panel (/admin)
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Inbox / Temp Mail UI (/)
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Catch-all 404
app.use((req, res) => {
  res.status(404).send('Page not found. <a href="/">Go to Inbox</a> or <a href="/admin">Go to Admin</a>');
});

// Start HTTP + Socket.io server
server.listen(PORT, () => {
  console.log(`Real-Time Push Temp Mail Server (Socket.io + ImapFlow IDLE) running on port ${PORT}`);
  console.log(`- Temp Mail Inbox: http://localhost:${PORT}/`);
  console.log(`- Admin Accounts Pool: http://localhost:${PORT}/admin`);
});
