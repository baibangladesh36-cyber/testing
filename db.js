const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DB_FILE = path.join(__dirname, 'accounts_db.json');

class AccountsDatabase {
  constructor() {
    this.accounts = [];
    this.init();
  }

  init() {
    try {
      if (fs.existsSync(DB_FILE)) {
        const raw = fs.readFileSync(DB_FILE, 'utf-8');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          this.accounts = parsed;
        } else if (parsed && Array.isArray(parsed.accounts)) {
          this.accounts = parsed.accounts;
        }
      } else {
        this.accounts = [];
        this.save();
      }
    } catch (err) {
      console.warn('[DB] Error loading accounts_db.json, starting empty:', err.message);
      this.accounts = [];
    }
  }

  reload() {
    try {
      if (fs.existsSync(DB_FILE)) {
        const raw = fs.readFileSync(DB_FILE, 'utf-8');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          this.accounts = parsed;
        } else if (parsed && Array.isArray(parsed.accounts)) {
          this.accounts = parsed.accounts;
        }
      }
    } catch (err) {}
  }

  save() {
    try {
      fs.writeFileSync(DB_FILE, JSON.stringify(this.accounts, null, 2), 'utf-8');
    } catch (err) {
      console.error('[DB] Failed to persist accounts_db.json:', err.message);
    }
  }

  // Get all accounts (with option to redact or include appPassword)
  getAll(includeSecrets = false) {
    this.reload();
    return this.accounts.map(acc => {
      const copy = { ...acc };
      if (!includeSecrets) {
        copy.appPassword = copy.appPassword ? `${copy.appPassword.slice(0, 3)}••••••••${copy.appPassword.slice(-3)}` : '';
      }
      return copy;
    });
  }

  // Find by ID
  findById(id, includeSecrets = true) {
    this.reload();
    const acc = this.accounts.find(a => String(a.id) === String(id));
    if (!acc) return null;
    const copy = { ...acc };
    if (!includeSecrets) {
      copy.appPassword = copy.appPassword ? `${copy.appPassword.slice(0, 3)}••••••••${copy.appPassword.slice(-3)}` : '';
    }
    return copy;
  }

  // Find by Email
  findByEmail(email) {
    this.reload();
    const clean = (email || '').trim().toLowerCase();
    return this.accounts.find(a => a.email.toLowerCase() === clean);
  }

  // Get first active account or random
  getActiveAccount(excludeId = null) {
    const actives = this.accounts.filter(a => a.status === 'active' && String(a.id) !== String(excludeId));
    if (actives.length > 0) {
      return actives[Math.floor(Math.random() * actives.length)];
    }
    // Fallback to any active account
    const anyActive = this.accounts.filter(a => a.status === 'active');
    if (anyActive.length > 0) {
      return anyActive[0];
    }
    // Fallback to any account
    return this.accounts[0] || null;
  }

  // Get next random account from the pool
  getRandomNext(currentId) {
    const pool = this.accounts.filter(a => a.status === 'active' && String(a.id) !== String(currentId));
    if (pool.length > 0) {
      return pool[Math.floor(Math.random() * pool.length)];
    }
    // If only 1 account exists or none different
    const fallback = this.accounts.find(a => a.status === 'active') || this.accounts[0] || null;
    return fallback;
  }

  // Add a single account
  addAccount(email, appPassword, status = 'active') {
    const cleanEmail = (email || '').trim().toLowerCase();
    const cleanPass = (appPassword || '').replace(/\s+/g, '').trim();

    if (!cleanEmail || !cleanPass) {
      throw new Error('Both email and app password are required');
    }

    const existing = this.findByEmail(cleanEmail);
    if (existing) {
      // Update existing
      existing.appPassword = cleanPass;
      existing.status = status;
      existing.updatedAt = new Date().toISOString();
      this.save();
      return existing;
    }

    const newAcc = {
      id: crypto.randomUUID ? crypto.randomUUID() : `acc_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      email: cleanEmail,
      appPassword: cleanPass,
      status: status, // 'active' | 'inactive' | 'error'
      lastUsedAt: null,
      lastTestedAt: null,
      lastTestResult: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    this.accounts.push(newAcc);
    this.save();
    return newAcc;
  }

  // Bulk import lines: "email:app_password" or "email,app_password" or "email app_password"
  bulkImport(linesText) {
    const lines = linesText.split(/\r?\n/);
    let addedCount = 0;
    let updatedCount = 0;
    let skippedCount = 0;
    const errors = [];

    for (let i = 0; i < lines.length; i++) {
      const rawLine = lines[i].trim();
      if (!rawLine || rawLine.startsWith('#')) {
        continue;
      }

      // Match email:password or email,password or email [space/tab] password
      let email = '';
      let password = '';

      if (rawLine.includes(':')) {
        const parts = rawLine.split(':');
        email = parts[0].trim();
        password = parts.slice(1).join(':').trim();
      } else if (rawLine.includes(',')) {
        const parts = rawLine.split(',');
        email = parts[0].trim();
        password = parts.slice(1).join(',').trim();
      } else {
        const parts = rawLine.split(/\s+/);
        if (parts.length >= 2) {
          email = parts[0].trim();
          password = parts.slice(1).join(' ').trim();
        }
      }

      // Clean password (remove inner spaces common in Google app passwords)
      const cleanPass = password.replace(/\s+/g, '');

      if (!email || !cleanPass || !email.includes('@')) {
        skippedCount++;
        errors.push(`Line ${i + 1}: Invalid format. Expected email:app_password`);
        continue;
      }

      const existing = this.findByEmail(email);
      if (existing) {
        existing.appPassword = cleanPass;
        existing.updatedAt = new Date().toISOString();
        updatedCount++;
      } else {
        this.accounts.push({
          id: crypto.randomUUID ? crypto.randomUUID() : `acc_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
          email: email.toLowerCase(),
          appPassword: cleanPass,
          status: 'active',
          lastUsedAt: null,
          lastTestedAt: null,
          lastTestResult: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        });
        addedCount++;
      }
    }

    this.save();
    return {
      added: addedCount,
      updated: updatedCount,
      skipped: skippedCount,
      total: this.accounts.length,
      errors: errors.slice(0, 5) // return up to 5 error samples
    };
  }

  // Delete account by ID
  deleteAccount(id) {
    const idx = this.accounts.findIndex(a => String(a.id) === String(id));
    if (idx === -1) return false;
    this.accounts.splice(idx, 1);
    this.save();
    return true;
  }

  // Update status (e.g. active/inactive)
  updateStatus(id, status) {
    const acc = this.accounts.find(a => String(a.id) === String(id));
    if (!acc) return null;
    acc.status = status;
    acc.updatedAt = new Date().toISOString();
    this.save();
    return acc;
  }

  // Record account usage
  recordUsage(id) {
    const acc = this.accounts.find(a => String(a.id) === String(id));
    if (acc) {
      acc.lastUsedAt = new Date().toISOString();
      this.save();
    }
  }

  // Record test result
  recordTestResult(id, success, message) {
    const acc = this.accounts.find(a => String(a.id) === String(id));
    if (acc) {
      acc.lastTestedAt = new Date().toISOString();
      acc.lastTestResult = {
        success,
        message,
        time: acc.lastTestedAt
      };
      acc.status = success ? 'active' : 'inactive';
      this.save();
    }
  }

  // Count summary
  getStats() {
    const total = this.accounts.length;
    const active = this.accounts.filter(a => a.status === 'active').length;
    const inactive = this.accounts.filter(a => a.status !== 'active').length;
    return { total, active, inactive };
  }
}

// Singleton instance
const db = new AccountsDatabase();

module.exports = db;
