// server.js
// node server.js

import express from "express";
import { MongoClient, ObjectId } from "mongodb";
import fs from "fs";
import crypto from "crypto";
import { renderServicesPage as renderServicesPageImpl } from "./src/pages/services.js";
import { renderScriptsPage as renderScriptsPageImpl } from "./src/pages/scripts.js";
import { renderOverviewPage as renderOverviewPageImpl } from "./src/pages/overview.js";
import { renderLogin as renderLoginImpl } from "./src/pages/login.js";

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ===================== CONFIG =====================
let FILE_CONFIG = {};
try {
  const raw = fs.readFileSync("./config.json", "utf-8");
  FILE_CONFIG = JSON.parse(raw);
} catch {}

const ADMIN_PASSWORD = FILE_CONFIG.ADMIN_PASSWORD || process.env.ADMIN_PASSWORD || "admin123";
const CONFIG = {
  WORKINK_LINK: FILE_CONFIG.WORKINK_LINK || process.env.WORKINK_LINK || "https://workink.net/26ij/6z67dpqo",
  YT_CHANNEL: FILE_CONFIG.YT_CHANNEL || process.env.YT_CHANNEL || "https://www.youtube.com/@yourchannel",
  DISCORD_WEBHOOK_URL: FILE_CONFIG.DISCORD_WEBHOOK_URL || process.env.DISCORD_WEBHOOK_URL || "",
  CHECKPOINTS: (() => {
    try {
      const fromEnv = process.env.CHECKPOINTS_JSON ? JSON.parse(process.env.CHECKPOINTS_JSON) : null;
      const fromFile = FILE_CONFIG.CHECKPOINTS || null;
      const base = fromEnv || fromFile;
      if (Array.isArray(base) && base.length > 0) return base.slice(0, 20);
    } catch {}
    return [
      { type: "youtube", label: "Subscribe on YouTube", url: FILE_CONFIG.YT_CHANNEL || process.env.YT_CHANNEL || "https://www.youtube.com/@yourchannel", duration: 10 },
      { type: "workink", label: "Complete Work.ink Task", url: FILE_CONFIG.WORKINK_LINK || process.env.WORKINK_LINK || "https://workink.net/26ij/6z67dpqo" },
    ];
  })(),
};

let KEY_BACKEND = FILE_CONFIG.KEY_BACKEND || process.env.KEY_BACKEND || "http://localhost:3000";
const MONGODB_URI = FILE_CONFIG.MONGODB_URI || process.env.MONGODB_URI || "";
const DB_NAME = FILE_CONFIG.DB_NAME || process.env.DB_NAME || "serrr";

function obfuscateLua(code) {
  try {
    const src = String(code || "");
    return "-- obfuscated\n" + src;
  } catch {
    return "-- obfuscated\n";
  }
}

function saveLocalConfig() {
  try {
    const next = {
      ADMIN_PASSWORD,
      KEY_BACKEND,
      MONGODB_URI,
      DB_NAME,
      WORKINK_LINK: CONFIG.WORKINK_LINK,
      YT_CHANNEL: CONFIG.YT_CHANNEL,
      DISCORD_WEBHOOK_URL: CONFIG.DISCORD_WEBHOOK_URL,
      CHECKPOINTS: CONFIG.CHECKPOINTS,
    };
    fs.writeFileSync("./config.json", JSON.stringify(next, null, 2));
  } catch (e) {
    console.error("save config error", e);
  }
}
// ===================== STORAGE (in-memory) =====================

const keys = new Map();
const tokenToKey = new Map();
const checkLogs = [];
const events = [];
const traffic = {
  getKey: [],
  checkpoint: [],
};

let mongoClient = null;
let db = null;
let colKeys = null;
let colChecks = null;
let colEvents = null;
let colConfig = null;
let colScripts = null;
let currentScript = null;

async function initDB() {
  if (!MONGODB_URI) {
    console.log("MongoDB disabled: no MONGODB_URI provided, running in-memory");
    return;
  }
  try {
    mongoClient = new MongoClient(MONGODB_URI);
    await mongoClient.connect();
    db = mongoClient.db(DB_NAME);
    colKeys = db.collection("keys");
    colChecks = db.collection("checks");
    colEvents = db.collection("events");
    colConfig = db.collection("config");
    colScripts = db.collection("scripts");

    await colKeys.createIndex({ key: 1 }, { unique: true });
    await colKeys.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
    await colKeys.createIndex({ fromWorkInkToken: 1 });
    await colChecks.createIndex({ key: 1 });
    await colChecks.createIndex({ at: -1 });
    await colScripts.createIndex({ createdAt: -1 });
    await colScripts.createIndex({ isActive: 1 });
    await colScripts.createIndex({ publicToken: 1 }, { unique: true, sparse: true });

    const docs = await colKeys.find({}).toArray();
    for (const doc of docs) {
      const createdAt = doc.createdAt ? new Date(doc.createdAt) : null;
      const expiresAt = doc.expiresAt ? new Date(doc.expiresAt) : null;
      const keyObj = {
        key: doc.key,
        createdAt,
        expiresAt,
        isActive: doc.isActive ?? true,
        usageCount: doc.usageCount ?? 0,
        maxUsage: doc.maxUsage ?? null,
        source: doc.source ?? null,
        fromWorkInkToken: doc.fromWorkInkToken ?? null,
        hwid: doc.hwid ?? null,
        robloxUserId: doc.robloxUserId ?? null,
        robloxUsername: doc.robloxUsername ?? null,
      };
      keys.set(keyObj.key, keyObj);
      if (keyObj.fromWorkInkToken) tokenToKey.set(keyObj.fromWorkInkToken, keyObj.key);
    }
    console.log(`MongoDB connected, loaded ${docs.length} keys`);

    const conf = await colConfig.findOne({ _id: "main" });
    if (conf) {
      CONFIG.WORKINK_LINK = conf.WORKINK_LINK || CONFIG.WORKINK_LINK;
      CONFIG.YT_CHANNEL = conf.YT_CHANNEL || CONFIG.YT_CHANNEL;
      CONFIG.DISCORD_WEBHOOK_URL = conf.DISCORD_WEBHOOK_URL || CONFIG.DISCORD_WEBHOOK_URL;
      KEY_BACKEND = conf.KEY_BACKEND || KEY_BACKEND;
    }

    const latestScript = await colScripts.find({ isActive: true }).sort({ createdAt: -1 }).limit(1).toArray();
    if (latestScript[0]) {
      const c = latestScript[0].obfuscatedCode || latestScript[0].originalCode || latestScript[0].content || "";
      currentScript = { content: c, updatedAt: latestScript[0].createdAt };
    }

    const needsMigration = await colScripts.find({ $or: [ { originalCode: { $exists: false } }, { obfuscatedCode: { $exists: false } }, { publicToken: { $exists: false } } ] }).toArray();
    for (const s of needsMigration) {
      const original = s.originalCode ?? s.content ?? "";
      const obf = s.obfuscatedCode ?? obfuscateLua(original);
      const token = s.publicToken ?? crypto.randomBytes(16).toString("hex");
      await colScripts.updateOne({ _id: s._id }, { $set: { originalCode: original, obfuscatedCode: obf, publicToken: token }, $unset: { content: "" } });
    }
  } catch (e) {
    console.error("MongoDB init error", e);
  }
}

// ===================== PAGE RENDERERS =====================

function renderOverviewPage(pass, rangeDays, clicks, checkpoints, totalKeys, keysGenerated, keysUsed, scriptExecutions, totalChecks, list) {
  const rows = list.slice(0, 10).map((item) => {
    const expired = item.expiresAt && item.expiresAt < new Date();
    const expStr = item.expiresAt ? item.expiresAt.toISOString().slice(0, 19).replace("T", " ") : "—";
    const createdStr = item.createdAt ? item.createdAt.toISOString().slice(0, 19).replace("T", " ") : "—";

    return `
    <tr class="border-b border-slate-800/30 hover:bg-slate-800/20 transition-colors">
      <td class="px-4 py-3">
        <div class="font-mono text-sm font-semibold text-blue-300">${item.key}</div>
      </td>
      <td class="px-4 py-3 text-slate-400 text-sm">${createdStr}</td>
      <td class="px-4 py-3 ${expired ? "text-rose-300" : "text-slate-300"} text-sm">${expStr}</td>
      <td class="px-4 py-3">
        ${item.isActive 
          ? '<span class="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium bg-emerald-500/10 text-emerald-300 border border-emerald-500/20">Active</span>' 
          : '<span class="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium bg-slate-500/10 text-slate-300 border border-slate-500/20">Inactive</span>'}
      </td>
      <td class="px-4 py-3 text-slate-300 text-sm font-medium">${item.usageCount || 0}${item.maxUsage ? " / " + item.maxUsage : ""}</td>
      <td class="px-4 py-3 text-slate-400 text-sm">${item.robloxUsername || item.robloxUserId || "—"}</td>
    </tr>
    `;
  }).join("");

  const recentLogs = checkLogs.slice().reverse().slice(0, 10).map((log) => {
    return `
    <tr class="border-b border-slate-800/20 hover:bg-slate-800/10 transition-colors">
      <td class="px-4 py-2.5 text-slate-400 text-xs">${log.at.toISOString().slice(0, 19).replace("T", " ")}</td>
      <td class="px-4 py-2.5 font-mono text-sm text-blue-300">${log.key || "—"}</td>
      <td class="px-4 py-2.5">
        ${log.ok 
          ? '<span class="inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium bg-emerald-500/10 text-emerald-300">OK</span>' 
          : `<span class="inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium bg-rose-500/10 text-rose-300">${log.reason}</span>`}
      </td>
      <td class="px-4 py-2.5 text-slate-400 text-xs">${log.username || "—"}</td>
    </tr>
    `;
  }).join("");

  return `
    <header class="glass border-b border-slate-800/50 px-6 py-5 sticky top-0 z-10">
      <div class="flex items-center justify-between">
        <div>
          <h1 class="text-2xl md:text-3xl font-semibold tracking-tight mb-1">Dashboard Overview</h1>
          <p class="text-sm text-slate-400">Key statistics for the last ${rangeDays} days</p>
        </div>
        <div class="flex gap-2">
          <a href="/admin?pass=${pass}&page=overview&range=7" class="px-4 py-2 rounded-lg ${rangeDays === 7 ? "bg-gradient-to-r from-blue-500 to-purple-600 text-white shadow-lg shadow-blue-500/30" : "glass text-slate-300 hover:text-white"} text-sm font-medium transition-all">7d</a>
          <a href="/admin?pass=${pass}&page=overview&range=14" class="px-4 py-2 rounded-lg ${rangeDays === 14 ? "bg-gradient-to-r from-blue-500 to-purple-600 text-white shadow-lg shadow-blue-500/30" : "glass text-slate-300 hover:text-white"} text-sm font-medium transition-all">14d</a>
          <a href="/admin?pass=${pass}&page=overview&range=30" class="px-4 py-2 rounded-lg ${rangeDays === 30 ? "bg-gradient-to-r from-blue-500 to-purple-600 text-white shadow-lg shadow-blue-500/30" : "glass text-slate-300 hover:text-white"} text-sm font-medium transition-all">30d</a>
        </div>
      </div>
    </header>

    <div class="p-6 space-y-6">
      <!-- Statistics Cards -->
      <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-4">
        <div class="stat-card">
          <div class="flex items-center justify-between mb-3">
            <div class="w-10 h-10 rounded-lg bg-blue-500/10 flex items-center justify-center">
              <svg class="w-5 h-5 text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 15l-2 5L9 9l11 4-5 2zm0 0l5 5M7.188 2.239l.777 2.897M5.136 7.965l-2.898-.777M13.95 4.05l-2.122 2.122m-5.657 5.656l-2.12 2.122"/>
              </svg>
            </div>
            <span class="text-xs text-slate-500">${rangeDays}d</span>
          </div>
          <p class="text-xs text-slate-400 mb-1 font-medium">Clicks</p>
          <p class="text-3xl font-bold text-blue-300">${clicks}</p>
        </div>

        <div class="stat-card">
          <div class="flex items-center justify-between mb-3">
            <div class="w-10 h-10 rounded-lg bg-emerald-500/10 flex items-center justify-center">
              <svg class="w-5 h-5 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"/>
              </svg>
            </div>
            <span class="text-xs text-slate-500">${rangeDays}d</span>
          </div>
          <p class="text-xs text-slate-400 mb-1 font-medium">Checkpoints</p>
          <p class="text-3xl font-bold text-emerald-300">${checkpoints}</p>
        </div>

        <div class="stat-card">
          <div class="flex items-center justify-between mb-3">
            <div class="w-10 h-10 rounded-lg bg-amber-500/10 flex items-center justify-center">
              <svg class="w-5 h-5 text-amber-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z"/>
              </svg>
            </div>
            <span class="text-xs text-slate-500">total</span>
          </div>
          <p class="text-xs text-slate-400 mb-1 font-medium">Total Keys</p>
          <p class="text-3xl font-bold text-amber-300">${totalKeys}</p>
        </div>

        <div class="stat-card">
          <div class="flex items-center justify-between mb-3">
            <div class="w-10 h-10 rounded-lg bg-purple-500/10 flex items-center justify-center">
              <svg class="w-5 h-5 text-purple-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 6v6m0 0v6m0-6h6m-6 0H6"/>
              </svg>
            </div>
            <span class="text-xs text-slate-500">${rangeDays}d</span>
          </div>
          <p class="text-xs text-slate-400 mb-1 font-medium">Generated</p>
          <p class="text-3xl font-bold text-purple-300">${keysGenerated}</p>
        </div>

        <div class="stat-card">
          <div class="flex items-center justify-between mb-3">
            <div class="w-10 h-10 rounded-lg bg-sky-500/10 flex items-center justify-center">
              <svg class="w-5 h-5 text-sky-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z"/>
              </svg>
            </div>
            <span class="text-xs text-slate-500">${rangeDays}d</span>
          </div>
          <p class="text-xs text-slate-400 mb-1 font-medium">Keys Used</p>
          <p class="text-3xl font-bold text-sky-300">${keysUsed}</p>
        </div>

        <div class="stat-card">
          <div class="flex items-center justify-between mb-3">
            <div class="w-10 h-10 rounded-lg bg-rose-500/10 flex items-center justify-center">
              <svg class="w-5 h-5 text-rose-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"/>
              </svg>
            </div>
            <span class="text-xs text-slate-500">${rangeDays}d</span>
          </div>
          <p class="text-xs text-slate-400 mb-1 font-medium">Executions</p>
          <p class="text-3xl font-bold text-rose-300">${scriptExecutions}</p>
        </div>
      </div>

      <!-- Recent Keys -->
      <div class="glass rounded-xl overflow-hidden">
        <div class="px-6 py-4 border-b border-slate-800/50 flex items-center justify-between">
          <div>
            <h2 class="text-lg font-semibold">Recent Keys</h2>
            <p class="text-sm text-slate-400 mt-1">Last 10 created keys</p>
          </div>
          <a href="/admin?pass=${pass}&page=keys" class="text-sm text-blue-400 hover:text-blue-300">View all →</a>
        </div>
        <div class="overflow-x-auto scrollbar">
          <table class="min-w-full">
            <thead class="bg-slate-900/50">
              <tr class="text-xs uppercase text-slate-400 tracking-wider">
                <th class="px-4 py-3 text-left font-semibold">Key</th>
                <th class="px-4 py-3 text-left font-semibold">Created</th>
                <th class="px-4 py-3 text-left font-semibold">Expires</th>
                <th class="px-4 py-3 text-left font-semibold">Status</th>
                <th class="px-4 py-3 text-left font-semibold">Usage</th>
                <th class="px-4 py-3 text-left font-semibold">Roblox</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-slate-800/30">
              ${rows || '<tr><td colspan="6" class="px-4 py-8 text-center text-slate-400">No keys yet</td></tr>'}
            </tbody>
          </table>
        </div>
      </div>

      <!-- Recent Checks -->
      <div class="glass rounded-xl overflow-hidden">
        <div class="px-6 py-4 border-b border-slate-800/50">
          <div class="flex items-center justify-between">
            <div>
              <h2 class="text-lg font-semibold">Recent Checks</h2>
              <p class="text-sm text-slate-400 mt-1">Last 10 verification attempts</p>
            </div>
            <span class="text-xs text-slate-500">${totalChecks} total checks</span>
          </div>
        </div>
        <div class="overflow-x-auto scrollbar">
          <table class="min-w-full">
            <thead class="bg-slate-900/50">
              <tr class="text-xs uppercase text-slate-400 tracking-wider">
                <th class="px-4 py-3 text-left font-semibold">Timestamp</th>
                <th class="px-4 py-3 text-left font-semibold">Key</th>
                <th class="px-4 py-3 text-left font-semibold">Result</th>
                <th class="px-4 py-3 text-left font-semibold">Username</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-slate-800/20">
              ${recentLogs || '<tr><td colspan="4" class="px-4 py-8 text-center text-slate-400">No checks yet</td></tr>'}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  `;
}

function renderKeysPage(pass, rangeDays, q, filter, list, csrf, pageInfo) {
  const rows = list.map((item) => {
    const expired = item.expiresAt && item.expiresAt < new Date();
    const expStr = item.expiresAt ? item.expiresAt.toISOString().slice(0, 19).replace("T", " ") : "—";
    const createdStr = item.createdAt ? item.createdAt.toISOString().slice(0, 19).replace("T", " ") : "—";
    const usagePct = item.maxUsage ? Math.min(100, Math.round(((item.usageCount || 0) / item.maxUsage) * 100)) : null;

    return `
    <tr class="border-b border-slate-800/30 hover:bg-slate-800/20 transition-colors">
      <td class="px-4 py-3">
        <div class="flex items-center gap-2">
          <div class="font-mono text-sm font-semibold text-blue-300">${item.key}</div>
          <button type="button" title="Copy" onclick="navigator.clipboard.writeText('${item.key}')" class="px-2 py-0.5 bg-blue-500/10 hover:bg-blue-500/20 text-blue-300 rounded-md text-xs border border-blue-500/20">Copy</button>
        </div>
      </td>
      <td class="px-4 py-3 text-slate-400 text-sm">${createdStr}</td>
      <td class="px-4 py-3 ${expired ? "text-rose-300" : "text-slate-300"} text-sm">${expStr}</td>
      <td class="px-4 py-3">
        ${item.isActive 
          ? '<span class="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium bg-emerald-500/10 text-emerald-300 border border-emerald-500/20">Active</span>' 
          : '<span class="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium bg-slate-500/10 text-slate-300 border border-slate-500/20">Inactive</span>'}
      </td>
      <td class="px-4 py-3 text-slate-300 text-sm font-medium">
        <div class="flex items-center gap-2">
          <span>${item.usageCount || 0}${item.maxUsage ? " / " + item.maxUsage : ""}</span>
          ${usagePct !== null ? `<div class="w-24 h-2 bg-slate-800/50 rounded-full overflow-hidden"><div class="h-2 bg-blue-500" style="width:${usagePct}%"></div></div>` : ''}
        </div>
      </td>
      <td class="px-4 py-3 text-slate-400 text-sm">${item.robloxUsername || item.robloxUserId || "—"}</td>
      <td class="px-4 py-3">
        <span class="inline-flex items-center px-2 py-0.5 rounded-md text-xs ${item.source === 'workink' ? 'bg-purple-500/10 text-purple-300' : 'bg-blue-500/10 text-blue-300'}">${item.source || "—"}</span>
      </td>
      <td class="px-4 py-3">
        <div class="flex gap-1.5">
          <form method="POST" action="/admin/action">
            <input type="hidden" name="pass" value="${pass}">
            <input type="hidden" name="csrf" value="${csrf}">
            <input type="hidden" name="action" value="deactivate">
            <input type="hidden" name="key" value="${item.key}">
            <button class="px-2.5 py-1 bg-amber-500/10 hover:bg-amber-500/20 text-amber-300 rounded-md text-xs font-medium transition-colors border border-amber-500/20">Off</button>
          </form>
          <form method="POST" action="/admin/action" onsubmit="return confirm('Delete ${item.key}?')">
            <input type="hidden" name="pass" value="${pass}">
            <input type="hidden" name="csrf" value="${csrf}">
            <input type="hidden" name="action" value="delete">
            <input type="hidden" name="key" value="${item.key}">
            <button class="px-2.5 py-1 bg-rose-500/10 hover:bg-rose-500/20 text-rose-300 rounded-md text-xs font-medium transition-colors border border-rose-500/20">Del</button>
          </form>
          <form method="POST" action="/admin/action">
            <input type="hidden" name="pass" value="${pass}">
            <input type="hidden" name="csrf" value="${csrf}">
            <input type="hidden" name="action" value="extend1h">
            <input type="hidden" name="key" value="${item.key}">
            <button class="px-2.5 py-1 bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-300 rounded-md text-xs font-medium transition-colors border border-emerald-500/20">+1h</button>
          </form>
          <form method="POST" action="/admin/action">
            <input type="hidden" name="pass" value="${pass}">
            <input type="hidden" name="csrf" value="${csrf}">
            <input type="hidden" name="action" value="extend24h">
            <input type="hidden" name="key" value="${item.key}">
            <button class="px-2.5 py-1 bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-300 rounded-md text-xs font-medium transition-colors border border-emerald-500/20">+24h</button>
          </form>
        </div>
      </td>
    </tr>
    `;
  }).join("");

  return `
    <header class="glass border-b border-slate-800/50 px-6 py-5 sticky top-0 z-10">
      <div>
        <h1 class="text-2xl md:text-3xl font-semibold tracking-tight mb-1">Key Management</h1>
        <p class="text-sm text-slate-400">Manage all your keys</p>
      </div>
    </header>

    <div class="p-6 space-y-6">
      <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <div class="stat-card">
          <div class="text-sm text-slate-400">Total Keys</div>
          <div class="text-2xl font-bold text-amber-300">${pageInfo.total}</div>
        </div>
        <div class="stat-card">
          <div class="text-sm text-slate-400">Active</div>
          <div class="text-2xl font-bold text-emerald-300">${pageInfo.active}</div>
        </div>
        <div class="stat-card">
          <div class="text-sm text-slate-400">Expired</div>
          <div class="text-2xl font-bold text-rose-300">${pageInfo.expired}</div>
        </div>
        <div class="stat-card">
          <div class="text-sm text-slate-400">Usage rate</div>
          <div class="text-2xl font-bold text-sky-300">${pageInfo.usageRate}%</div>
        </div>
      </div>

      <!-- Filters and Actions -->
      <div class="glass rounded-xl p-6 space-y-4">
        <h2 class="text-lg font-semibold mb-4">Filters & Actions</h2>
        
        <!-- Search & Filter -->
        <form method="GET" action="/admin" class="flex flex-wrap gap-3">
          <input type="hidden" name="pass" value="${pass}">
          <input type="hidden" name="page" value="keys">
          <input type="hidden" name="range" value="${rangeDays}">
          <input type="hidden" name="p" value="1">
          <div class="flex-1 min-w-[200px]">
            <input name="q" value="${q}" class="input" placeholder="Search keys, roblox, token...">
          </div>
          <select name="filter" class="input">
            <option value="all" ${filter === "all" ? "selected" : ""}>All Keys</option>
            <option value="active" ${filter === "active" ? "selected" : ""}>Active Only</option>
            <option value="expired" ${filter === "expired" ? "selected" : ""}>Expired Only</option>
            <option value="workink" ${filter === "workink" ? "selected" : ""}>Work.ink Source</option>
            <option value="admin" ${filter === "admin" ? "selected" : ""}>Manual Created</option>
          </select>
          <button class="btn btn-primary">
            Apply Filters
          </button>
          <a href="/admin/export-keys.csv?pass=${pass}&filter=${encodeURIComponent(filter)}&q=${encodeURIComponent(q)}" class="btn btn-muted">Export CSV</a>
        </form>

        <!-- Create Key Form -->
        <form method="POST" action="/admin/create-key" class="glass rounded-xl p-5 border border-slate-700/50">
          <input type="hidden" name="pass" value="${pass}">
          <input type="hidden" name="csrf" value="${csrf}">
          <div class="flex items-center gap-2 mb-4">
            <svg class="w-5 h-5 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 6v6m0 0v6m0-6h6m-6 0H6"/>
            </svg>
            <h3 class="font-semibold">Create New Key</h3>
          </div>
          <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 xl:grid-cols-7 gap-3">
            <input name="customKey" class="input" placeholder="Custom key (optional)">
            <input name="hours" type="number" value="1" class="input" placeholder="Hours">
            <input name="maxUsage" type="number" class="input" placeholder="Max uses">
            <input name="robloxUserId" class="input" placeholder="Roblox userId">
            <input name="robloxUsername" class="input" placeholder="Roblox username">
            <input name="hwid" class="input" placeholder="HWID">
            <button class="btn btn-primary">Create Key</button>
          </div>
        </form>

        <!-- Bulk Actions -->
        <div class="flex justify-end">
          <a href="/admin/delete-expired?pass=${pass}" onclick="return confirm('Delete all expired keys?')" class="btn btn-outline-rose inline-flex items-center gap-2">
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/>
            </svg>
            Delete Expired Keys
          </a>
        </div>
      </div>

      <!-- Keys Table -->
      <div class="glass rounded-xl overflow-hidden">
        <div class="px-6 py-4 border-b border-slate-800/50">
          <h2 class="text-lg font-semibold">All Keys</h2>
          <p class="text-sm text-slate-400 mt-1">${pageInfo.total} total • page ${pageInfo.page} / ${pageInfo.pages}</p>
        </div>
        <div class="overflow-x-auto scrollbar">
          <table class="min-w-full">
            <thead class="bg-slate-900/50">
              <tr class="text-xs uppercase text-slate-400 tracking-wider">
                <th class="px-4 py-3 text-left font-semibold">Key</th>
                <th class="px-4 py-3 text-left font-semibold">Created</th>
                <th class="px-4 py-3 text-left font-semibold">Expires</th>
                <th class="px-4 py-3 text-left font-semibold">Status</th>
                <th class="px-4 py-3 text-left font-semibold">Usage</th>
                <th class="px-4 py-3 text-left font-semibold">Roblox</th>
                <th class="px-4 py-3 text-left font-semibold">Source</th>
                <th class="px-4 py-3 text-left font-semibold">Actions</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-slate-800/30">
              ${rows || '<tr><td colspan="8" class="px-4 py-8 text-center text-slate-400">No keys found</td></tr>'}
            </tbody>
          </table>
        </div>
        <div class="px-6 py-4 flex items-center justify-between border-t border-slate-800/50">
          <a class="btn btn-muted" href="/admin?pass=${pass}&page=keys&range=${rangeDays}&filter=${encodeURIComponent(filter)}&q=${encodeURIComponent(q)}&p=${Math.max(1, pageInfo.page-1)}">Prev</a>
          <div class="text-sm text-slate-400">Page ${pageInfo.page} of ${pageInfo.pages}</div>
          <a class="btn btn-muted" href="/admin?pass=${pass}&page=keys&range=${rangeDays}&filter=${encodeURIComponent(filter)}&q=${encodeURIComponent(q)}&p=${Math.min(pageInfo.pages, pageInfo.page+1)}">Next</a>
        </div>
      </div>
    </div>
  `;
}

function renderServicesPage(pass, csrf) {
  return `
    <header class="glass border-b border-slate-800/50 px-6 py-5 sticky top-0 z-10">
      <div>
        <h1 class="text-2xl md:text-3xl font-semibold tracking-tight mb-1">Services</h1>
        <p class="text-sm text-slate-400">Manage external integrations</p>
      </div>
    </header>

    <div class="p-6 space-y-6">
      <!-- Work.ink Service -->
      <div class="glass rounded-xl p-6">
        <div class="flex items-start gap-4 mb-6">
          <div class="w-12 h-12 rounded-xl bg-gradient-to-br from-purple-500 to-pink-600 flex items-center justify-center shadow-lg shadow-purple-500/30">
            <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9"/>
            </svg>
          </div>
          <div class="flex-1">
            <div class="flex items-center gap-3 mb-2">
              <h2 class="text-xl font-bold">Work.ink</h2>
              <span class="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium bg-emerald-500/10 text-emerald-300 border border-emerald-500/20">Active</span>
            </div>
            <p class="text-slate-400 text-sm mb-4">Monetization service for key generation</p>
            
        <div class="space-y-3">
          <form method="POST" action="/admin/update-config" class="glass rounded-lg p-4 border border-slate-700/50 space-y-2">
            <input type="hidden" name="pass" value="${pass}">
            <input type="hidden" name="csrf" value="${csrf}">
            <label class="block text-xs text-slate-400 mb-2 uppercase tracking-wider">Backend Base URL (domain)</label>
            <div class="flex gap-2">
              <input name="KEY_BACKEND" type="text" value="${KEY_BACKEND}" class="input font-mono flex-1">
              <button type="button" onclick="navigator.clipboard.writeText(document.querySelector('[name=KEY_BACKEND]').value)" class="btn btn-outline-blue">Copy</button>
            </div>
            <label class="block text-xs text-slate-400 mb-2 uppercase tracking-wider">Work.ink URL</label>
            <div class="flex gap-2">
              <input name="WORKINK_LINK" type="text" value="${CONFIG.WORKINK_LINK}" class="input font-mono flex-1">
              <button type="button" onclick="navigator.clipboard.writeText(document.querySelector('[name=WORKINK_LINK]').value)" class="btn btn-outline-blue">Copy</button>
            </div>
            <div class="mt-3">
              <label class="block text-xs text-slate-400 mb-2 uppercase tracking-wider">YouTube Channel URL</label>
              <input name="YT_CHANNEL" type="text" value="${CONFIG.YT_CHANNEL}" class="input font-mono w-full">
            </div>
            <div class="mt-3">
              <label class="block text-xs text-slate-400 mb-2 uppercase tracking-wider">Discord Webhook URL</label>
              <input name="DISCORD_WEBHOOK_URL" type="text" value="${CONFIG.DISCORD_WEBHOOK_URL}" class="input font-mono w-full">
            </div>
            <div class="mt-3">
              <label class="block text-xs text-slate-400 mb-2 uppercase tracking-wider">Verification Steps</label>
              <div class="glass rounded-xl p-4 border border-slate-700/30 space-y-3">
                <div class="flex items-center justify-between">
                  <div class="text-sm text-slate-400">Шаги верификации</div>
                  <button type="button" id="add-step" class="btn btn-outline-blue btn-sm">Add Step</button>
                </div>
                <div id="steps-canvas" class="space-y-3"></div>
              </div>
              <input type="hidden" name="CHECKPOINTS_JSON" id="CHECKPOINTS_JSON" value="[]">
              
              <!-- Visual Step Builder Script -->
              <script type="text/plain">
                (function(){
                  const canvas = document.getElementById('steps-canvas');
                  const hidden = document.getElementById('CHECKPOINTS_JSON');
                  const preview = null;
                  const addBtn = null;
                  const YT_CHANNEL = ${JSON.stringify((CONFIG.YT_CHANNEL || "").replace(/[^\x20-\x7E]/g, ""))};
                  const WORKINK_LINK = ${JSON.stringify((CONFIG.WORKINK_LINK || "").replace(/[^\x20-\x7E]/g, ""))};
                  
                  // Initial data
                  const initial = ${JSON.stringify(CONFIG.CHECKPOINTS || [])};
                  let steps = Array.isArray(initial) ? initial.slice(0,20) : [];
                  
                  // Convert old format to new format
                  steps = steps.map(function(s){
                    if (s && s.kind === 'group') return s;
                    if (!s) return { kind:'group', mode:'any', name:'', description:'', items: [] };
                    return { kind:'group', mode:(s.mode==='all'?'all':'any'), name:'', description:'', items: [ { type:s.type||'link', label:s.label||'', url:s.url||'', duration:s.duration } ] };
                  });

                  // Templates
                  const templates = {
                    youtube: {
                      name: "Subscribe to YouTube",
                      description: "Subscribe to our YouTube channel and stay for 30 seconds",
                      mode: "any",
                      items: [{
                        type: "youtube",
                        label: "Subscribe on YouTube",
                        url: YT_CHANNEL,
                        duration: 30
                      }]
                    },
                    telegram: {
                      name: "Join Telegram",
                      description: "Join our Telegram group",
                      mode: "any", 
                      items: [{
                        type: "telegram",
                        label: "Join Telegram Group",
                        url: "https://t.me/yourgroup",
                        duration: 0
                      }]
                    },
                    discord: {
                      name: "Join Discord",
                      description: "Join our Discord server",
                      mode: "any",
                      items: [{
                        type: "discord", 
                        label: "Join Discord Server",
                        url: "https://discord.gg/yourserver",
                        duration: 0
                      }]
                    },
                    workink: {
                      name: "Complete Task",
                      description: "Complete the Work.ink task",
                      mode: "any",
                      items: [{
                        type: "workink",
                        label: "Complete Work.ink Task", 
                        url: WORKINK_LINK,
                        duration: 0
                      }]
                    }
                  };

                  // Render functions
                  function createStepCard(step, index) {
                    const itemCount = step.items ? step.items.length : 0;
                    const modeText = step.mode === 'all' ? 'All required' : 'Any required';
                    
                    return '<div class="step-card glass rounded-lg p-4 border border-slate-700/30 hover:border-slate-600/50 transition-all" data-index="' + index + '">' +
                      '<div class="flex items-center justify-between mb-3">' +
                        '<div class="flex items-center gap-3">' +
                          '<div class="w-8 h-8 rounded-full bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center text-sm font-bold">' + (index + 1) + '</div>' +
                          '<div>' +
                            '<div class="font-semibold text-white">' + (step.name || 'Untitled Step') + '</div>' +
                            '<div class="text-xs text-slate-400">' + itemCount + ' task' + (itemCount !== 1 ? 's' : '') + ' • ' + modeText + '</div>' +
                          '</div>' +
                        '</div>' +
                        '<div class="flex items-center gap-1">' +
                          '<button class="btn btn-sm btn-outline-amber" data-action="edit" title="Edit">' +
                            '<svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">' +
                              '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/>' +
                            '</svg>' +
                          '</button>' +
                          '<button class="btn btn-sm btn-outline-rose" data-action="delete" title="Delete">' +
                            '<svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">' +
                              '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/>' +
                            '</svg>' +
                          '</button>' +
                        '</div>' +
                      '</div>' +
                      
                      '<div class="space-y-2">' +
                        (step.description ? '<div class="text-sm text-slate-300 mb-2">' + step.description + '</div>' : '') +
                        
                        (step.items ? step.items.map(function(item, i) {
                          return '<div class="flex items-center gap-3 p-2 bg-slate-800/30 rounded-lg">' +
                            '<div class="w-6 h-6 rounded bg-gradient-to-br from-' + getItemColor(item.type)[0] + '-500 to-' + getItemColor(item.type)[1] + '-600"></div>' +
                            '<div class="flex-1">' +
                              '<div class="text-sm font-medium">' + item.label + '</div>' +
                              (item.duration > 0 ? '<div class="text-xs text-slate-400">Stay for ' + item.duration + 's</div>' : '') +
                            '</div>' +
                            '<button class="btn btn-xs btn-outline-slate" data-action="edit-item" data-item-index="' + i + '">' +
                              'Edit' +
                            '</button>' +
                          '</div>';
                        }).join('') : '') +
                        
                        '' +
                      '</div>' +
                    '</div>';
                  }

                  function getItemColor(type) {
                    const colors = {
                      youtube: ['red', 'pink'],
                      telegram: ['sky', 'cyan'], 
                      discord: ['indigo', 'violet'],
                      workink: ['purple', 'pink'],
                      link: ['blue', 'cyan']
                    };
                    return colors[type] || ['blue', 'cyan'];
                  }

                  function renderCanvas() {
                    if (steps.length === 0) {
                      canvas.innerHTML = '<div class="text-center text-slate-400 py-8">' +
                        '<svg class="w-12 h-12 mx-auto mb-4 opacity-50" fill="none" stroke="currentColor" viewBox="0 0 24 24">' +
                          '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10"/>' +
                        '</svg>' +
                        'No steps yet. Click "Add Step" to begin.' +
                      '</div>';
                    } else {
                      canvas.innerHTML = steps.map(function(step, i) { return createStepCard(step, i); }).join('');
                    }
                    hidden.value = JSON.stringify(steps);
                  }

                  function updateHiddenField() {
                    hidden.value = JSON.stringify(steps);
                  }

                  function updatePreview() {
                    if (steps.length === 0) {
                      preview.innerHTML = '<div class="text-center text-slate-500 text-sm">Preview will appear here</div>';
                      return;
                    }

                    // Simulate user view
                    let previewHtml = '';
                    steps.forEach(function(step, i) {
                      const status = i === 0 ? 'current' : 'pending';
                      const stepClass = status === 'current' ? 'border-blue-500/50 bg-blue-500/10' : 'border-slate-700/30';
                      
                      previewHtml += '<div class="mb-3 p-3 rounded-lg border ' + stepClass + '">' +
                        '<div class="flex items-center gap-3 mb-2">' +
                          '<div class="w-6 h-6 rounded-full ' + (status === 'current' ? 'bg-blue-500' : 'bg-slate-600') + ' flex items-center justify-center text-xs font-bold">' +
                            (i + 1) +
                          '</div>' +
                          '<div class="font-semibold ' + (status === 'current' ? 'text-white' : 'text-slate-400') + '">' + step.name + '</div>' +
                        '</div>' +
                        (step.description ? '<div class="text-sm text-slate-300 mb-2 ml-9">' + step.description + '</div>' : '') +
                        (step.items ? step.items.map(function(item) {
                          return '<div class="flex items-center gap-2 ml-9 text-sm text-slate-400">' +
                            '<div class="w-4 h-4 rounded bg-gradient-to-br from-' + getItemColor(item.type)[0] + '-500 to-' + getItemColor(item.type)[1] + '-600"></div>' +
                            item.label +
                          '</div>';
                        }).join('') : '') +
                      '</div>';
                    });
                    
                    preview.innerHTML = previewHtml;
                  }

                  // Event handlers
                  canvas.addEventListener('click', function(e) {
                    const btn = e.target.closest('button[data-action]');
                    if (!btn) return;
                    
                    const card = btn.closest('.step-card');
                    const index = parseInt(card.dataset.index);
                    const action = btn.dataset.action;
                    
                    if (action === 'delete') {
                      if (confirm('Delete this step?')) {
                        steps.splice(index, 1);
                        renderCanvas();
                      }
                    }
                  });

                  

                  // Template buttons
                  document.querySelectorAll('.template-btn').forEach(function(btn) {
                    btn.addEventListener('click', function() {
                      const template = templates[this.dataset.template];
                      if (template) {
                        steps.push(JSON.parse(JSON.stringify(template)));
                        renderCanvas();
                      }
                    });
                  });

                  function createNewStep() {
                    const name = prompt('Step name:');
                    if (!name) return;
                    
                    const description = prompt('Step description (optional):');
                    const mode = confirm('Require ALL tasks to be completed?\n\nOK = All required\nCancel = Any required') ? 'all' : 'any';
                    
                    steps.push({
                      kind: 'group',
                      mode: mode,
                      name: name,
                      description: description || '',
                      items: []
                    });
                    
                    renderCanvas();
                  }

                  function editStep(index) {
                    const step = steps[index];
                    const newName = prompt('Step name:', step.name);
                    if (newName === null) return;
                    
                    const newDesc = prompt('Step description:', step.description);
                    const newMode = confirm('Require ALL tasks to be completed?\n\nOK = All required\nCancel = Any required') ? 'all' : 'any';
                    
                    step.name = newName || step.name;
                    step.description = newDesc !== null ? newDesc : step.description;
                    step.mode = newMode;
                    
                    renderCanvas();
                  }

                  function addItemToStep(stepIndex) {
                    const step = steps[stepIndex];
                    const types = [
                      { value: 'youtube', text: 'YouTube Channel' },
                      { value: 'telegram', text: 'Telegram Group' },
                      { value: 'discord', text: 'Discord Server' },
                      { value: 'workink', text: 'Work.ink Task' },
                      { value: 'link', text: 'Custom Link' }
                    ];
                    
                    const typeChoice = prompt('Select task type:\n\n' + types.map(function(t, i) { return (i + 1) + '. ' + t.text; }).join('\n') + '\n\nEnter number:');
                    if (!typeChoice) return;
                    
                    const typeIndex = parseInt(typeChoice) - 1;
                    if (typeIndex < 0 || typeIndex >= types.length) return;
                    
                    const type = types[typeIndex].value;
                    const label = prompt('Task label:', getDefaultLabel(type));
                    if (!label) return;
                    
                    const url = prompt('URL:', getDefaultUrl(type));
                    if (!url) return;
                    
                    const duration = type === 'youtube' ? parseInt(prompt('Stay duration (seconds):', '30')) : 0;
                    
                    step.items.push({
                      type: type,
                      label: label,
                      url: url,
                      duration: duration || 0
                    });
                    
                    renderCanvas();
                  }

                  function editItem(stepIndex, itemIndex) {
                    const step = steps[stepIndex];
                    const item = step.items[itemIndex];
                    
                    const newLabel = prompt('Task label:', item.label);
                    if (newLabel === null) return;
                    
                    const newUrl = prompt('URL:', item.url);
                    if (newUrl === null) return;
                    
                    const newDuration = item.type === 'youtube' ? parseInt(prompt('Stay duration (seconds):', item.duration)) : item.duration;
                    
                    item.label = newLabel || item.label;
                    item.url = newUrl || item.url;
                    item.duration = newDuration || 0;
                    
                    renderCanvas();
                  }

                  function getDefaultLabel(type) {
                    const defaults = {
                      youtube: 'Subscribe on YouTube',
                      telegram: 'Join Telegram Group',
                      discord: 'Join Discord Server',
                      workink: 'Complete Work.ink Task',
                      link: 'Open Link'
                    };
                    return defaults[type] || 'Open Link';
                  }

                  function getDefaultUrl(type) {
                    const defaults = {
                      youtube: YT_CHANNEL,
                      telegram: 'https://t.me/yourgroup',
                      discord: 'https://discord.gg/yourserver',
                      workink: WORKINK_LINK,
                      link: 'https://example.com'
                    };
                    return defaults[type] || 'https://example.com';
                  }

                  // Initial render
                  renderCanvas();
                })();
              </script>
              <script type="text/plain">
                (function(){
                  var canvas = document.getElementById('steps-canvas');
                  var hidden = document.getElementById('CHECKPOINTS_JSON');
                  var addBtn = document.getElementById('add-step-visual');
                  var initial = ${JSON.stringify(CONFIG.CHECKPOINTS || [])};
                  var steps = Array.isArray(initial) ? initial.slice(0,20) : [];
                  steps = steps.map(function(s){
                    if (!s) return { kind:'group', mode:'any', name:'', description:'', items: [] };
                    if (s.kind === 'group') { s.mode = (s.mode === 'all') ? 'all' : 'any'; s.items = Array.isArray(s.items) ? s.items : []; return s; }
                    return { kind:'group', mode:(s.mode==='all'?'all':'any'), name:(s.name||''), description:(s.description||''), items:[{ type:(s.type||'link'), label:(s.label||'Open Link'), url:(s.url||''), duration:(s.duration||0) }] };
                  });
                  function updateHidden(){ hidden.value = JSON.stringify(steps); }
                  function makeInput(value, placeholder, onChange){ var i=document.createElement('input'); i.type='text'; i.className='input w-full'; i.value=value||''; i.placeholder=placeholder||''; i.addEventListener('input', function(){ onChange(i.value); updateHidden(); }); return i; }
                  function makeNumber(value, onChange){ var i=document.createElement('input'); i.type='number'; i.min='0'; i.className='input w-24'; i.value=String(value||0); i.addEventListener('input', function(){ var v=parseInt(i.value)||0; onChange(v); updateHidden(); }); return i; }
                  function makeSelect(options, value, onChange){ var s=document.createElement('select'); s.className='input'; options.forEach(function(opt){ var o=document.createElement('option'); o.value=opt.value; o.text=opt.text; s.appendChild(o); }); s.value=value; s.addEventListener('change', function(){ onChange(s.value); updateHidden(); }); return s; }
                  function render(){ while(canvas.firstChild) canvas.removeChild(canvas.firstChild); if(!steps.length){ var empty=document.createElement('div'); empty.className='text-center text-slate-400 py-8'; empty.textContent='No steps'; canvas.appendChild(empty); updateHidden(); return; } steps.forEach(function(step, idx){ var card=document.createElement('div'); card.className='glass rounded-lg p-4 border border-slate-700/30 space-y-3'; var header=document.createElement('div'); header.className='flex items-center justify-between'; var left=document.createElement('div'); left.className='flex items-center gap-2'; var nameInput=makeInput(step.name, 'Step name', function(v){ step.name=v; }); left.appendChild(nameInput); var modeSel=makeSelect([{value:'all',text:'All required'},{value:'any',text:'Any required'}], step.mode, function(v){ step.mode=v; }); left.appendChild(modeSel); header.appendChild(left); var del=document.createElement('button'); del.className='btn btn-outline-rose btn-sm'; del.textContent='Delete step'; del.addEventListener('click', function(){ steps.splice(idx,1); render(); }); header.appendChild(del); card.appendChild(header); var descInput=makeInput(step.description, 'Description (optional)', function(v){ step.description=v; }); card.appendChild(descInput); var itemsWrap=document.createElement('div'); itemsWrap.className='space-y-2'; (step.items||[]).forEach(function(item, ii){ var row=document.createElement('div'); row.className='flex items-center gap-2'; var typeSel=makeSelect([{value:'youtube',text:'YouTube'},{value:'discord',text:'Discord'},{value:'workink',text:'Work.ink'},{value:'lootlab',text:'LootLab'},{value:'linkverse',text:'Linkverse'},{value:'link',text:'Link'}], item.type||'link', function(v){ item.type=v; }); row.appendChild(typeSel); var labelInput=makeInput(item.label, 'Label', function(v){ item.label=v; }); row.appendChild(labelInput); var urlInput=makeInput(item.url, 'URL', function(v){ item.url=v; }); row.appendChild(urlInput); var durInput=makeNumber(item.duration||0, function(v){ item.duration=v; }); row.appendChild(durInput); var delItem=document.createElement('button'); delItem.className='btn btn-outline-rose btn-sm'; delItem.textContent='Delete'; delItem.addEventListener('click', function(){ step.items.splice(ii,1); render(); }); row.appendChild(delItem); itemsWrap.appendChild(row); }); var addItem=document.createElement('button'); addItem.className='btn btn-outline-blue btn-sm'; addItem.textContent='Add task'; addItem.addEventListener('click', function(){ step.items = step.items || []; step.items.push({ type:'link', label:'Open Link', url:'https://example.com', duration:0 }); render(); }); card.appendChild(itemsWrap); card.appendChild(addItem); canvas.appendChild(card); }); updateHidden(); }
                  if (addBtn) { addBtn.addEventListener('click', function(){ steps.push({ kind:'group', mode:'all', name:'New Step', description:'', items: [] }); render(); }); }
                  render();
              })();
              </script>
              <script type="text/javascript">
                (function(){
                  var canvas = document.getElementById('steps-canvas');
                  var addBtn = document.getElementById('add-step');
                  var hidden = document.getElementById('CHECKPOINTS_JSON');
                  var initial = ${JSON.stringify(CONFIG.CHECKPOINTS || [])};
                  var steps = Array.isArray(initial) ? initial.slice(0,20) : [];
                  steps = steps.map(function(s){
                    if (!s) return { kind:'group', mode:'any', name:'', description:'', items: [] };
                    if (s.kind === 'group') { s.mode = (s.mode === 'all') ? 'all' : 'any'; s.items = Array.isArray(s.items) ? s.items : []; return s; }
                    return { kind:'group', mode:(s.mode==='all'?'all':'any'), name:(s.name||''), description:(s.description||''), items:[{ type:(s.type||'link'), label:(s.label||'Open Link'), url:(s.url||''), duration:(s.duration||0) }] };
                  });
                  function updateHidden(){ hidden.value = JSON.stringify(steps); }
                  function makeInput(value, placeholder, onChange){ var i=document.createElement('input'); i.type='text'; i.className='input w-full'; i.value=value||''; i.placeholder=placeholder||''; i.addEventListener('input', function(){ onChange(i.value); updateHidden(); }); return i; }
                  function makeNumber(value, onChange){ var i=document.createElement('input'); i.type='number'; i.min='0'; i.className='input w-24'; i.value=String(value||0); i.addEventListener('input', function(){ var v=parseInt(i.value)||0; onChange(v); updateHidden(); }); return i; }
                  function makeSelect(options, value, onChange){ var s=document.createElement('select'); s.className='input'; options.forEach(function(opt){ var o=document.createElement('option'); o.value=opt.value; o.text=opt.text; s.appendChild(o); }); s.value=value; s.addEventListener('change', function(){ onChange(s.value); updateHidden(); }); return s; }
                  function render(){ while(canvas.firstChild) canvas.removeChild(canvas.firstChild); if(!steps.length){ var empty=document.createElement('div'); empty.className='text-center text-slate-400 py-8'; empty.textContent='Нет шагов'; canvas.appendChild(empty); updateHidden(); return; } steps.forEach(function(step, idx){ var card=document.createElement('div'); card.className='glass rounded-lg p-4 border border-slate-700/30 space-y-3'; var header=document.createElement('div'); header.className='flex items-center justify-between'; var left=document.createElement('div'); left.className='flex items-center gap-2'; var nameInput=makeInput(step.name, 'Название шага', function(v){ step.name=v; }); left.appendChild(nameInput); var modeSel=makeSelect([{value:'all',text:'Требуются все'},{value:'any',text:'Любой один'}], step.mode, function(v){ step.mode=v; }); left.appendChild(modeSel); header.appendChild(left); var del=document.createElement('button'); del.className='btn btn-outline-rose btn-sm'; del.textContent='Удалить шаг'; del.addEventListener('click', function(){ steps.splice(idx,1); render(); }); header.appendChild(del); card.appendChild(header); var info=document.createElement('div'); info.className='text-xs text-slate-400'; info.textContent=String((step.items||[]).length)+' пункт(ов) • '+(step.mode==='all'?'требуются все':'любой один'); card.appendChild(info); var descInput=makeInput(step.description, 'Описание (необязательно)', function(v){ step.description=v; }); card.appendChild(descInput); var itemsWrap=document.createElement('div'); itemsWrap.className='space-y-2'; (step.items||[]).forEach(function(item, ii){ var row=document.createElement('div'); row.className='flex items-center gap-2'; var typeSel=makeSelect([{value:'youtube',text:'YouTube'},{value:'discord',text:'Discord'},{value:'workink',text:'Work.ink'},{value:'lootlab',text:'LootLab'},{value:'linkverse',text:'Linkverse'},{value:'link',text:'Link'}], item.type||'link', function(v){ item.type=v; }); row.appendChild(typeSel); var labelInput=makeInput(item.label, 'Название', function(v){ item.label=v; }); row.appendChild(labelInput); var urlInput=makeInput(item.url, 'Ссылка', function(v){ item.url=v; }); row.appendChild(urlInput); var durInput=makeNumber(item.duration||0, function(v){ item.duration=v; }); row.appendChild(durInput); var delItem=document.createElement('button'); delItem.className='btn btn-outline-rose btn-sm'; delItem.textContent='Удалить'; delItem.addEventListener('click', function(){ step.items.splice(ii,1); render(); }); row.appendChild(delItem); itemsWrap.appendChild(row); }); var addItem=document.createElement('button'); addItem.className='btn btn-outline-blue btn-sm'; addItem.textContent='Добавить пункт'; addItem.addEventListener('click', function(){ step.items = step.items || []; step.items.push({ type:'link', label:'Open Link', url:'https://example.com', duration:0 }); render(); }); card.appendChild(itemsWrap); card.appendChild(addItem); canvas.appendChild(card); }); updateHidden(); }
                  if (addBtn) { addBtn.addEventListener('click', function(){ steps.push({ kind:'group', mode:'any', name:'New Step', description:'', items: [] }); render(); }); }
                  render();
                })();
              </script>
            </div>
            <div class="text-right">
              <button class="btn btn-primary">Save Settings</button>
            </div>
          </form>

              <div class="glass rounded-lg p-4 border border-slate-700/50">
                <label class="block text-xs text-slate-400 mb-2 uppercase tracking-wider">Return URL</label>
                <div class="flex gap-2">
                  <input type="text" value="${KEY_BACKEND}/workink-return" readonly class="input font-mono flex-1">
                  <button onclick="navigator.clipboard.writeText('${KEY_BACKEND}/workink-return')" class="btn btn-outline-blue">Copy</button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- YouTube Service -->
      <div class="glass rounded-xl p-6">
        <div class="flex items-start gap-4 mb-6">
          <div class="w-12 h-12 rounded-xl bg-gradient-to-br from-red-500 to-pink-600 flex items-center justify-center shadow-lg shadow-red-500/30">
            <svg class="w-6 h-6" fill="currentColor" viewBox="0 0 24 24">
              <path d="M21.8 8s-.2-1.5-.8-2.2c-.8-.8-1.6-.8-2-.9C15.8 4.7 12 4.7 12 4.7s-3.8 0-7 .2c-.4 0-1.2.1-2 .9C2.3 6.5 2.2 8 2.2 8S2 9.6 2 11.3v1.3C2 14.3 2.2 16 2.2 16s.2 1.5.8 2.2c.8.8 1.6.8 2 .9 1.4.1 7 .2 7 .2s3.8 0 7-.2c.4-.1 1.2-.1 2-.9.6-.7.8-2.2.8-2.2s.2-1.7.2-3.4V11.3C22 9.6 21.8 8 21.8 8zM10 14.7V9.3l5.3 2.7L10 14.7z"/>
            </svg>
          </div>
          <div class="flex-1">
            <div class="flex items-center gap-3 mb-2">
              <h2 class="text-xl font-bold">YouTube Checkpoint</h2>
              <span class="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium bg-emerald-500/10 text-emerald-300 border border-emerald-500/20">Active</span>
            </div>
            <p class="text-slate-400 text-sm mb-4">First verification step before Work.ink</p>
            
            <div class="glass rounded-lg p-4 border border-slate-700/50">
              <label class="block text-xs text-slate-400 mb-2 uppercase tracking-wider">Channel URL</label>
              <div class="flex gap-2">
                <input type="text" value="${CONFIG.YT_CHANNEL}" readonly class="flex-1 bg-slate-950/40 border border-slate-700 rounded-lg px-3 py-2 text-sm font-mono">
                <a href="${CONFIG.YT_CHANNEL}" target="_blank" class="btn btn-outline-red">Open</a>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- API Endpoints -->
      <div class="glass rounded-xl p-6">
        <div class="mb-6">
          <h2 class="text-xl font-bold mb-2">API Endpoints</h2>
          <p class="text-slate-400 text-sm">Available endpoints for integration</p>
        </div>

        <div class="space-y-3">
          <div class="flex items-center justify-between p-4 glass rounded-lg border border-slate-700/50">
            <div class="flex-1">
              <div class="flex items-center gap-2 mb-1">
                <span class="px-2 py-0.5 rounded text-xs font-mono bg-emerald-500/10 text-emerald-300">GET</span>
                <code class="text-sm font-mono text-slate-200">/gate</code>
              </div>
              <p class="text-xs text-slate-400">Get key generation URL</p>
            </div>
          </div>

          <div class="flex items-center justify-between p-4 glass rounded-lg border border-slate-700/50">
            <div class="flex-1">
              <div class="flex items-center gap-2 mb-1">
                <span class="px-2 py-0.5 rounded text-xs font-mono bg-emerald-500/10 text-emerald-300">GET</span>
                <code class="text-sm font-mono text-slate-200">/check</code>
              </div>
              <p class="text-xs text-slate-400">Verify key validity (for Roblox scripts)</p>
            </div>
          </div>

          <div class="flex items-center justify-between p-4 glass rounded-lg border border-slate-700/50">
            <div class="flex-1">
              <div class="flex items-center gap-2 mb-1">
                <span class="px-2 py-0.5 rounded text-xs font-mono bg-emerald-500/10 text-emerald-300">GET</span>
                <code class="text-sm font-mono text-slate-200">/get-key</code>
              </div>
              <p class="text-xs text-slate-400">User checkpoint page (YouTube verification)</p>
            </div>
          </div>

          <div class="flex items-center justify-between p-4 glass rounded-lg border border-slate-700/50">
            <div class="flex-1">
              <div class="flex items-center gap-2 mb-1">
                <span class="px-2 py-0.5 rounded text-xs font-mono bg-blue-500/10 text-blue-300">POST</span>
                <code class="text-sm font-mono text-slate-200">/yt-done</code>
              </div>
              <p class="text-xs text-slate-400">YouTube checkpoint completion</p>
            </div>
          </div>

          <div class="flex items-center justify-between p-4 glass rounded-lg border border-slate-700/50">
            <div class="flex-1">
              <div class="flex items-center gap-2 mb-1">
                <span class="px-2 py-0.5 rounded text-xs font-mono bg-emerald-500/10 text-emerald-300">GET</span>
                <code class="text-sm font-mono text-slate-200">/workink-return</code>
              </div>
              <p class="text-xs text-slate-400">Work.ink return handler</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;
}

function renderScriptsPage(req, pass, csrf, scriptsList) {
  const baseUrl = getBaseUrl(req);
  const tiles = (scriptsList || []).map((s) => {
    const name = s.name || "Untitled";
    const desc = s.description || "";
    const preview = String(s.originalCode || s.content || '').slice(0, 120).replace(/[<>&]/g, (c) => ({"<":"&lt;",">":"&gt;","&":"&amp;"}[c]));
    const publicUrl = `${baseUrl}/s/${s.publicToken || ''}`;
    const copySnippet = `loadstring(game:HttpGet("${publicUrl}"))()`
      .replace(/&/g, "&amp;")
      .replace(/"/g, "&quot;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
    return `
      <div class="glass rounded-xl p-4 border border-slate-700/50 ${s.isActive ? 'ring-1 ring-emerald-500/30' : ''}">
        <div class="flex items-center justify-between mb-2">
          <div>
            <h3 class="text-sm font-semibold">${name}</h3>
            <p class="text-xs text-slate-400">${desc}</p>
          </div>
          <span class="px-2 py-0.5 rounded text-xs ${s.isActive ? 'bg-emerald-500/10 text-emerald-300 border border-emerald-500/20' : 'bg-slate-500/10 text-slate-300 border border-slate-500/20'}">${s.isActive ? 'Enabled' : 'Disabled'}</span>
        </div>
        <pre class="text-[11px] bg-slate-950/40 border border-slate-700 rounded-lg p-2 font-mono overflow-x-auto">${preview}...</pre>
        <div class="mt-3 flex flex-wrap gap-2">
          <button onclick="openEdit('${s._id}','${encodeURIComponent(name)}','${encodeURIComponent(desc)}')" class="px-3 py-1.5 rounded bg-blue-500/10 text-blue-300 text-xs border border-blue-500/20">Редактировать</button>
          <form method="POST" action="/admin/script-action" class="inline" onsubmit="return confirm('Удалить скрипт?')">
            <input type="hidden" name="pass" value="${pass}">
            <input type="hidden" name="csrf" value="${csrf}">
            <input type="hidden" name="id" value="${s._id}">
            <input type="hidden" name="action" value="delete">
            <button class="px-3 py-1.5 rounded bg-rose-500/10 text-rose-300 text-xs border border-rose-500/20">Удалить</button>
          </form>
          ${s.isActive ? `
          <form method="POST" action="/admin/script-action" class="inline" onsubmit="return confirm('Отключить скрипт?')">
            <input type="hidden" name="pass" value="${pass}">
            <input type="hidden" name="csrf" value="${csrf}">
            <input type="hidden" name="id" value="${s._id}">
            <input type="hidden" name="action" value="deactivate">
            <button class="px-3 py-1.5 rounded bg-amber-500/10 text-amber-300 text-xs border border-amber-500/20">Отключить</button>
          </form>
          ` : `
          <form method="POST" action="/admin/script-action" class="inline">
            <input type="hidden" name="pass" value="${pass}">
            <input type="hidden" name="csrf" value="${csrf}">
            <input type="hidden" name="id" value="${s._id}">
            <input type="hidden" name="action" value="activate">
            <button class="px-3 py-1.5 rounded bg-emerald-500/10 text-emerald-300 text-xs border border-emerald-500/20">Включить</button>
          </form>
          `}
          <button onclick="copyLoadstring(this)" data-loadstring="${copySnippet}" class="px-3 py-1.5 rounded bg-indigo-500/10 text-indigo-300 text-xs border border-indigo-500/20">Копировать loadstring</button>
        </div>
      </div>
    `;
  }).join("");
  return `
    <header class="glass border-b border-slate-800/50 px-6 py-5 sticky top-0 z-10">
      <div class="flex items-center justify-between">
        <div>
          <h1 class="text-2xl md:text-3xl font-semibold tracking-tight mb-1">Scripts</h1>
          <p class="text-sm text-slate-400">Manage Roblox executor scripts</p>
        </div>
        <button onclick="openCreate()" class="btn btn-primary">Создать скрипт</button>
      </div>
    </header>

    <div class="p-6 space-y-6">
      <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        ${tiles || '<div class="glass rounded-xl p-6 text-slate-400">Нет скриптов</div>'}
      </div>

      
    </div>

    <div id="modal-backdrop" class="fixed inset-0 bg-black/50 hidden"></div>
    <div id="modal" class="fixed inset-0 flex items-center justify-center hidden">
      <div class="w-full max-w-2xl glass rounded-2xl p-6">
        <h2 id="modal-title" class="text-lg font-semibold mb-3">Создать скрипт</h2>
        <form id="modal-form" method="POST" action="/admin/script-create" class="space-y-3">
          <input type="hidden" name="pass" value="${pass}">
          <input type="hidden" name="csrf" value="${csrf}">
          <input type="hidden" name="id" value="">
          <div>
            <label class="text-xs text-slate-400">Название *</label>
            <input name="name" required class="input">
          </div>
          <div>
            <label class="text-xs text-slate-400">Описание</label>
            <input name="description" class="input">
          </div>
          <div>
            <label class="text-xs text-slate-400">Код скрипта</label>
            <textarea id="code-input" name="content" rows="10" class="input font-mono" style="min-height: 200px"></textarea>
            <pre class="mt-2 bg-slate-950/40 border border-slate-700 rounded-lg p-3 text-xs overflow-x-auto"><code id="code-preview" class="language-lua"></code></pre>
          </div>
          <div class="flex justify-end gap-2">
            <button type="button" onclick="closeModal()" class="btn btn-muted">Отмена</button>
            <button class="btn btn-primary">Сохранить</button>
          </div>
        </form>
      </div>
    </div>

    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/prismjs@1/themes/prism-tomorrow.min.css" />
    <script src="https://cdn.jsdelivr.net/npm/prismjs@1/components/prism-core.min.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/prismjs@1/components/prism-clike.min.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/prismjs@1/components/prism-lua.min.js"></script>
    <script>
      const backdrop = document.getElementById('modal-backdrop');
      const modal = document.getElementById('modal');
      const form = document.getElementById('modal-form');
      const title = document.getElementById('modal-title');
      const codeInput = document.getElementById('code-input');
      const codePreview = document.getElementById('code-preview');
      function openCreate(){
        title.textContent = 'Создать скрипт';
        form.action = '/admin/script-create';
        form.name.value=''; form.description.value=''; form.id.value=''; codeInput.value=''; codePreview.textContent=''; Prism.highlightElement(codePreview);
        backdrop.classList.remove('hidden'); modal.classList.remove('hidden');
      }
      function openEdit(id,name,desc){
        title.textContent = 'Редактировать скрипт';
        form.action = '/admin/script-update';
        form.id.value = id;
        form.name.value = decodeURIComponent(name);
        form.description.value = decodeURIComponent(desc);
        codeInput.value = '';
        codePreview.textContent = '';
        backdrop.classList.remove('hidden'); modal.classList.remove('hidden');
      }
      function openRename(id,name,desc){
        title.textContent = 'Изменить имя/описание';
        form.action = '/admin/script-update';
        form.id.value = id;
        form.name.value = decodeURIComponent(name);
        form.description.value = decodeURIComponent(desc);
        codeInput.value = '';
        codePreview.textContent = '';
        backdrop.classList.remove('hidden'); modal.classList.remove('hidden');
      }
      function closeModal(){ backdrop.classList.add('hidden'); modal.classList.add('hidden'); }
      codeInput.addEventListener('input', ()=>{ codePreview.textContent = codeInput.value; Prism.highlightElement(codePreview); });
      function copyLoadstring(el){
        const text = el.getAttribute('data-loadstring') || '';
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(()=>{ const prev = el.textContent; el.textContent='Скопировано'; setTimeout(()=>{ el.textContent=prev; }, 1500); });
        } else {
          const ta = document.createElement('textarea');
          ta.value = text; document.body.appendChild(ta); ta.select();
          try { document.execCommand('copy'); } catch(e) {}
          document.body.removeChild(ta);
        }
      }
    </script>
  `;
}

function renderWebhooksPage(pass) {
  return `
    <header class="glass border-b border-slate-800/50 px-6 py-5 sticky top-0 z-10">
      <div>
        <h1 class="text-2xl md:text-3xl font-semibold tracking-tight mb-1">Webhooks</h1>
        <p class="text-sm text-slate-400">Manage Discord notifications</p>
      </div>
    </header>

    <div class="p-6 space-y-6">
      <!-- Discord Webhook -->
      <div class="glass rounded-xl p-6">
        <div class="flex items-start gap-4 mb-6">
          <div class="w-12 h-12 rounded-xl bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center shadow-lg shadow-indigo-500/30">
            <svg class="w-6 h-6" fill="currentColor" viewBox="0 0 24 24">
              <path d="M20.317 4.37a19.791 19.791 0 00-4.885-1.515a.074.074 0 00-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 00-5.487 0a12.64 12.64 0 00-.617-1.25a.077.077 0 00-.079-.037A19.736 19.736 0 003.677 4.37a.07.07 0 00-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 00.031.057a19.9 19.9 0 005.993 3.03a.078.078 0 00.084-.028a14.09 14.09 0 001.226-1.994a.076.076 0 00-.041-.106a13.107 13.107 0 01-1.872-.892a.077.077 0 01-.008-.128a10.2 10.2 0 00.372-.292a.074.074 0 01.077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 01.078.01c.12.098.246.198.373.292a.077.077 0 01-.006.127a12.299 12.299 0 01-1.873.892a.077.077 0 00-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 00.084.028a19.839 19.839 0 006.002-3.03a.077.077 0 00.032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 00-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419c0-1.333.956-2.419 2.157-2.419c1.21 0 2.176 1.096 2.157 2.42c0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419c0-1.333.955-2.419 2.157-2.419c1.21 0 2.176 1.096 2.157 2.42c0 1.333-.946 2.418-2.157 2.418z"/>
            </svg>
          </div>
          <div class="flex-1">
            <div class="flex items-center gap-3 mb-2">
              <h2 class="text-xl font-bold">Discord Webhook</h2>
              <span class="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium ${CONFIG.DISCORD_WEBHOOK_URL ? 'bg-emerald-500/10 text-emerald-300 border border-emerald-500/20' : 'bg-slate-500/10 text-slate-300 border border-slate-500/20'}">${CONFIG.DISCORD_WEBHOOK_URL ? 'Active' : 'Not configured'}</span>
            </div>
            <p class="text-slate-400 text-sm mb-4">Receive notifications for key events</p>
            
            ${CONFIG.DISCORD_WEBHOOK_URL ? `
            <div class="glass rounded-lg p-4 border border-slate-700/50 mb-4">
              <label class="block text-xs text-slate-400 mb-2 uppercase tracking-wider">Webhook URL</label>
              <div class="flex gap-2">
                <input type="text" value="${CONFIG.DISCORD_WEBHOOK_URL.slice(0, 50)}..." readonly class="flex-1 bg-slate-950/40 border border-slate-700 rounded-lg px-3 py-2 text-sm font-mono">
                <button onclick="navigator.clipboard.writeText('${CONFIG.DISCORD_WEBHOOK_URL}')" class="px-4 py-2 bg-blue-500/10 hover:bg-blue-500/20 text-blue-300 rounded-lg text-sm font-medium border border-blue-500/20">Copy</button>
              </div>
            </div>
            ` : ''}

            <div class="space-y-2">
              <h3 class="font-semibold text-sm mb-3">Tracked Events:</h3>
              <div class="flex items-center gap-3 p-3 glass rounded-lg">
                <div class="w-8 h-8 rounded-lg bg-emerald-500/10 flex items-center justify-center">
                  <svg class="w-4 h-4 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 6v6m0 0v6m0-6h6m-6 0H6"/>
                  </svg>
                </div>
                <div>
                  <p class="text-sm font-medium">Key Created (Work.ink)</p>
                  <p class="text-xs text-slate-400">When user completes Work.ink verification</p>
                </div>
              </div>

              <div class="flex items-center gap-3 p-3 glass rounded-lg">
                <div class="w-8 h-8 rounded-lg bg-blue-500/10 flex items-center justify-center">
                  <svg class="w-4 h-4 text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z"/>
                  </svg>
                </div>
                <div>
                  <p class="text-sm font-medium">Key Created (Admin)</p>
                  <p class="text-xs text-slate-400">When admin manually creates a key</p>
                </div>
              </div>
            </div>

            <div class="mt-4 p-4 bg-blue-500/5 border border-blue-500/20 rounded-lg">
              <div class="flex items-start gap-3">
                <svg class="w-5 h-5 text-blue-400 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>
                </svg>
                <div>
                  <p class="text-sm font-medium text-blue-300 mb-1">Setup Instructions</p>
                  <p class="text-xs text-slate-400">Set via Admin or DISCORD_WEBHOOK_URL env. Get webhook URL in Discord Server Settings → Integrations → Webhooks.</p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Test Webhook -->
      <div class="glass rounded-xl p-6">
        <h2 class="text-lg font-semibold mb-4">Test Webhook</h2>
        <p class="text-slate-400 text-sm mb-4">Send a test notification to verify webhook configuration</p>
        
        <form method="POST" action="/admin/test-webhook" class="flex gap-3">
          <input type="hidden" name="pass" value="${pass}">
          <input name="message" class="input flex-1" placeholder="Test message (optional)">
          <button ${!CONFIG.DISCORD_WEBHOOK_URL ? 'disabled' : ''} class="btn btn-primary ${!CONFIG.DISCORD_WEBHOOK_URL ? 'opacity-50 cursor-not-allowed' : ''}">
            Send Test
          </button>
        </form>
      </div>

      <!-- Webhook Logs (Future) -->
      <div class="glass rounded-xl p-6">
        <div class="text-center py-8">
          <svg class="w-12 h-12 text-slate-600 mx-auto mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"/>
          </svg>
          <h3 class="text-lg font-semibold mb-2">Webhook History</h3>
          <p class="text-sm text-slate-400">Webhook delivery logs coming soon</p>
        </div>
      </div>
    </div>
  `;
}

function renderSettingsPage(pass) {
  return `
    <header class="glass border-b border-slate-800/50 px-6 py-5 sticky top-0 z-10">
      <div>
        <h1 class="text-2xl md:text-3xl font-semibold tracking-tight mb-1">Settings</h1>
        <p class="text-sm text-slate-400">System configuration</p>
      </div>
    </header>

    <div class="p-6 space-y-6">
      <!-- System Info -->
      <div class="glass rounded-xl p-6">
        <h2 class="text-lg font-semibold mb-4">System Information</h2>
        <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div class="glass rounded-lg p-4 border border-slate-700/50">
            <label class="block text-xs text-slate-400 mb-2 uppercase tracking-wider">Total Keys</label>
            <p class="text-2xl font-bold text-blue-300">${keys.size}</p>
          </div>
          
          <div class="glass rounded-lg p-4 border border-slate-700/50">
            <label class="block text-xs text-slate-400 mb-2 uppercase tracking-wider">Total Checks</label>
            <p class="text-2xl font-bold text-emerald-300">${checkLogs.length}</p>
          </div>

          <div class="glass rounded-lg p-4 border border-slate-700/50">
            <label class="block text-xs text-slate-400 mb-2 uppercase tracking-wider">Total Events</label>
            <p class="text-2xl font-bold text-purple-300">${events.length}</p>
          </div>

          <div class="glass rounded-lg p-4 border border-slate-700/50">
            <label class="block text-xs text-slate-400 mb-2 uppercase tracking-wider">Get-Key Clicks</label>
            <p class="text-2xl font-bold text-amber-300">${traffic.getKey.length}</p>
          </div>
        </div>
      </div>

      <!-- Environment Variables -->
      <div class="glass rounded-xl p-6">
        <h2 class="text-lg font-semibold mb-4">Configuration</h2>
        <div class="space-y-4">
          <div class="glass rounded-lg p-4 border border-slate-700/50">
            <div class="flex items-center justify-between mb-2">
              <label class="text-xs text-slate-400 uppercase tracking-wider">Admin Password</label>
              <span class="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium ${ADMIN_PASSWORD === 'admin123' ? 'bg-amber-500/10 text-amber-300 border border-amber-500/20' : 'bg-emerald-500/10 text-emerald-300 border border-emerald-500/20'}">
                ${ADMIN_PASSWORD === 'admin123' ? 'Default' : 'Custom'}
              </span>
            </div>
            <p class="text-sm text-slate-300 font-mono">••••••••</p>
            ${ADMIN_PASSWORD === 'admin123' ? '<p class="text-xs text-amber-400 mt-2">⚠️ Using default password. Set ADMIN_PASSWORD env variable for security.</p>' : ''}
          </div>

          <div class="glass rounded-lg p-4 border border-slate-700/50">
            <label class="block text-xs text-slate-400 mb-2 uppercase tracking-wider">Work.ink Link</label>
            <div class="flex gap-2">
          <input type="text" value="${CONFIG.WORKINK_LINK}" readonly class="input font-mono flex-1">
          <button onclick="navigator.clipboard.writeText('${CONFIG.WORKINK_LINK}')" class="btn btn-outline-blue">Copy</button>
            </div>
            <p class="text-xs text-slate-400 mt-2">Configured via Admin or WORKINK_LINK env</p>
          </div>

          <div class="glass rounded-lg p-4 border border-slate-700/50">
            <label class="block text-xs text-slate-400 mb-2 uppercase tracking-wider">YouTube Channel</label>
            <div class="flex gap-2">
              <input type="text" value="${CONFIG.YT_CHANNEL}" readonly class="flex-1 bg-slate-950/40 border border-slate-700 rounded-lg px-3 py-2 text-sm font-mono">
              <a href="${CONFIG.YT_CHANNEL}" target="_blank" class="btn btn-outline-red">Open</a>
            </div>
            <p class="text-xs text-slate-400 mt-2">Configured via Admin or YT_CHANNEL env</p>
          </div>

          <div class="glass rounded-lg p-4 border border-slate-700/50">
            <label class="block text-xs text-slate-400 mb-2 uppercase tracking-wider">Discord Webhook</label>
            <div class="flex items-center justify-between">
              <span class="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium ${CONFIG.DISCORD_WEBHOOK_URL ? 'bg-emerald-500/10 text-emerald-300 border border-emerald-500/20' : 'bg-slate-500/10 text-slate-300 border border-slate-500/20'}">
                ${CONFIG.DISCORD_WEBHOOK_URL ? 'Configured' : 'Not set'}
              </span>
              ${CONFIG.DISCORD_WEBHOOK_URL ? `<button onclick=\"navigator.clipboard.writeText('${CONFIG.DISCORD_WEBHOOK_URL}')\" class=\"btn btn-outline-blue text-xs\">Copy URL</button>` : ''}
            </div>
            <p class="text-xs text-slate-400 mt-2">Configured via Admin or DISCORD_WEBHOOK_URL env</p>
          </div>
        </div>
      </div>

      <!-- Data Management -->
      <div class="glass rounded-xl p-6">
        <h2 class="text-lg font-semibold mb-4">Data Management</h2>
        <div class="space-y-3">
          <div class="flex items-center justify-between p-4 glass rounded-lg border border-slate-700/50">
            <div>
              <p class="font-medium mb-1">Clear Expired Keys</p>
              <p class="text-xs text-slate-400">Remove all keys that have expired</p>
            </div>
            <a href="/admin/delete-expired?pass=${pass}" onclick="return confirm('Delete all expired keys?')" class="btn btn-outline-amber">
              Clear Expired
            </a>
          </div>

          <div class="flex items-center justify-between p-4 glass rounded-lg border border-slate-700/50">
            <div>
              <p class="font-medium mb-1">Clear Check Logs</p>
              <p class="text-xs text-slate-400">Remove verification attempt history (${checkLogs.length} entries)</p>
            </div>
            <form method="POST" action="/admin/clear-logs" onsubmit="return confirm('Clear all check logs?')">
              <input type="hidden" name="pass" value="${pass}">
              <button class="btn btn-outline-amber">
                Clear Logs
              </button>
            </form>
          </div>

          <div class="flex items-center justify-between p-4 glass rounded-lg border border-rose-700/50">
            <div>
              <p class="font-medium mb-1 text-rose-300">Clear All Data</p>
              <p class="text-xs text-slate-400">⚠️ Remove all keys, logs, and events (cannot be undone)</p>
            </div>
            <form method="POST" action="/admin/clear-all" onsubmit="return confirm('⚠️ This will delete ALL data! Are you absolutely sure?')">
              <input type="hidden" name="pass" value="${pass}">
              <button class="btn btn-outline-rose">
                Clear All
              </button>
            </form>
          </div>
        </div>
      </div>

      <!-- About -->
      <div class="glass rounded-xl p-6">
        <h2 class="text-lg font-semibold mb-4">About</h2>
        <div class="space-y-2 text-sm text-slate-300">
          <p><strong>Version:</strong> 1.0.0</p>
          <p><strong>Type:</strong> Key Management System</p>
          <p><strong>Storage:</strong> ${db ? 'MongoDB (persistent)' : 'In-memory (resets on restart)'}</p>
          <p><strong>Status:</strong> <span class="text-emerald-400">Running</span></p>
        </div>
      </div>
    </div>
  `;
}

// ===================== HELPERS =====================

function addEvent(type, key) {
  events.push({ type, key, at: new Date() });
  if (events.length > 2000) events.shift();
}

function countEventsInRange(days, type) {
  const now = Date.now();
  const limit = now - days * 24 * 60 * 60 * 1000;
  return events.filter(
    (e) => (!type || e.type === type) && e.at.getTime() >= limit
  ).length;
}

function countArrayInRange(arr, days) {
  const now = Date.now();
  const limit = now - days * 24 * 60 * 60 * 1000;
  return arr.filter((d) => d.getTime() >= limit).length;
}

function makeKey() {
  return crypto.randomBytes(4).toString("hex").toUpperCase();
}

function getBaseUrl(req) {
  return `${req.protocol}://${req.get("host")}`;
}

function parseCookies(req) {
  const header = req.headers.cookie;
  const obj = {};
  if (!header) return obj;
  header.split(";").forEach((pair) => {
    const [k, ...v] = pair.trim().split("=");
    obj[k] = decodeURIComponent(v.join("="));
  });
  return obj;
}


function rateLimit(options) {
  const store = new Map();
  const windowMs = options.windowMs || 60000;
  const max = options.max || 60;
  return (req, res, next) => {
    const ip = req.headers["x-forwarded-for"]?.split(",")[0].trim() || req.ip || req.connection.remoteAddress || "unknown";
    const key = ip + ":" + req.path;
    const now = Date.now();
    const bucket = Math.floor(now / windowMs);
    const rec = store.get(key);
    if (!rec || rec.bucket !== bucket) {
      store.set(key, { bucket, count: 1 });
      return next();
    }
    rec.count++;
    if (rec.count > max) {
      return res.status(429).json({ error: "rate_limited" });
    }
    next();
  };
}

const defaultLimiter = rateLimit({ windowMs: 60000, max: 60 });
const strictLimiter = rateLimit({ windowMs: 60000, max: 20 });

async function sendWebhook(eventName, data) {
  if (!CONFIG.DISCORD_WEBHOOK_URL) return;
  try {
    await fetch(CONFIG.DISCORD_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "Key Bot",
        embeds: [
          {
            title: eventName,
            color: 0x5865f2,
            timestamp: new Date().toISOString(),
            fields: Object.entries(data || {}).map(([name, value]) => ({
              name,
              value:
                value === undefined || value === null ? "—" : String(value),
              inline: true,
            })),
          },
        ],
      }),
    });
  } catch (e) {
    console.error("webhook error", e);
  }
}

// ===================== ADMIN GUARD =====================

function renderLogin() {
  return `
  <!doctype html><html><head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Admin Login</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
    <style>
      :root {
        --bg-1: #0f172a;
        --bg-2: #1e1b4b;
        --bg-3: #312e81;
        --bg-4: #1e293b;
        --surface: rgba(15,23,42,0.72);
        --border: rgba(148,163,184,0.12);
      }
      @keyframes gradient { 0% { background-position: 0% 50%; } 50% { background-position: 100% 50%; } 100% { background-position: 0% 50%; } }
      body { background: linear-gradient(-45deg, var(--bg-1), var(--bg-2), var(--bg-3), var(--bg-4)); background-size: 400% 400%; animation: gradient 15s ease infinite; font-family: Inter, ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica Neue, Arial, "Noto Sans", "Apple Color Emoji", "Segoe UI Emoji"; }
      .glass { background: var(--surface); backdrop-filter: blur(20px); border: 1px solid var(--border); }
      
      /* Step Builder Styles */
      .step-card {
        transition: all 0.2s ease;
      }
      .step-card:hover {
        transform: translateY(-2px);
        box-shadow: 0 10px 25px rgba(0,0,0,0.3);
      }
      .btn-sm {
        padding: 0.25rem 0.5rem;
        font-size: 0.75rem;
        line-height: 1rem;
      }
      .btn-xs {
        padding: 0.125rem 0.375rem;
        font-size: 0.65rem;
        line-height: 0.875rem;
      }
      .template-btn {
        transition: all 0.2s ease;
        border-width: 1px;
      }
      .template-btn:hover {
        transform: translateY(-1px);
        box-shadow: 0 4px 12px rgba(59, 130, 246, 0.3);
      }
      #steps-canvas::-webkit-scrollbar {
        width: 6px;
      }
      #steps-canvas::-webkit-scrollbar-track {
        background: rgba(15, 23, 42, 0.5);
        border-radius: 3px;
      }
      #steps-canvas::-webkit-scrollbar-thumb {
        background: rgba(59, 130, 246, 0.5);
        border-radius: 3px;
      }
      #steps-canvas::-webkit-scrollbar-thumb:hover {
        background: rgba(59, 130, 246, 0.7);
      }
    </style>
  </head>
  <body class="min-h-screen flex items-center justify-center p-4">
    <div class="w-full max-w-md">
      <div class="text-center mb-8">
        <div class="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-gradient-to-br from-blue-500 to-purple-600 mb-4 shadow-2xl shadow-blue-500/30">
          <svg class="w-8 h-8 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z"/>
          </svg>
        </div>
        <h1 class="text-3xl font-bold text-white mb-2">Admin Access</h1>
        <p class="text-slate-400">Enter your credentials to continue</p>
      </div>
      
      <form method="GET" action="/admin" class="glass rounded-2xl p-8 shadow-2xl">
        <div class="space-y-6">
          <div>
            <label class="block text-sm font-medium text-slate-300 mb-2">Password</label>
            <input 
              name="pass" 
              type="password" 
              required
              class="w-full bg-slate-900/50 border border-slate-700 rounded-xl px-4 py-3 text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all" 
              placeholder="Enter admin password"
            />
          </div>
          
          <button class="w-full bg-gradient-to-r from-blue-500 to-purple-600 hover:from-blue-600 hover:to-purple-700 py-3 rounded-xl text-white font-semibold shadow-lg shadow-blue-500/30 transition-all transform hover:scale-[1.02] active:scale-[0.98]">
            Sign In
          </button>
        </div>
      </form>
      
      <p class="text-center text-slate-500 text-sm mt-6">Protected by enterprise-grade security</p>
    </div>
  </body>
  </html>`;
}

function requireAdmin(req, res, next) {
  const pass = req.query.pass || req.body.pass;
  if (pass === ADMIN_PASSWORD) return next();
  res.send(renderLoginImpl());
}

// ===================== ROUTES =====================

app.get("/gate", defaultLimiter, (req, res) => {
  res.json({
    url: getBaseUrl(req) + "/get-key",
  });
});

app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "key-manager",
    storage: db ? "mongodb" : "memory",
    mongo: Boolean(db),
  });
});

app.get("/metrics", (req, res) => {
  const active = Array.from(keys.values()).filter((k) => k.isActive && (!k.expiresAt || k.expiresAt > new Date())).length;
  res.json({
    storage: db ? "mongodb" : "memory",
    keys: { total: keys.size, active },
    checks: { total: checkLogs.length },
    events: {
      total: events.length,
      created_7d: countEventsInRange(7, "created"),
      used_7d: countEventsInRange(7, "used"),
    },
    traffic: {
      getKey: traffic.getKey.length,
      checkpoint: traffic.checkpoint.length,
    },
    timestamp: new Date().toISOString(),
  });
});

app.get("/script.lua", defaultLimiter, (req, res) => {
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  if (currentScript && currentScript.content) {
    return res.send(currentScript.content);
  }
  res.status(404).send("return print('no script configured')");
});

app.get("/scripts/:id/raw", defaultLimiter, async (req, res) => {
  res.status(403).send(`
    <!doctype html>
    <html>
    <head><meta charset="utf-8"><title>Нет доступа</title></head>
    <body style="background:#020617;color:#e5e7eb;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;">
      <div>
        <h1 style="font-size:24px;margin-bottom:8px;">Нет доступа к просмотру скрипта</h1>
        <p style="color:#9ca3af">Этот скрипт защищён. Используйте loadstring в Roblox, а не прямой просмотр.</p>
      </div>
    </body>
    </html>
  `);
});

app.get("/s/:token", defaultLimiter, async (req, res) => {
  const token = req.params.token;
  if (!token || !colScripts) return res.status(404).send("-- script not found");
  try {
    const doc = await colScripts.findOne({ publicToken: token });
    if (!doc || !doc.obfuscatedCode) return res.status(404).send("-- script not found");
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    return res.send(doc.obfuscatedCode);
  } catch {
    return res.status(404).send("-- script not found");
  }
});

app.get("/get-key", strictLimiter, (req, res) => {
  traffic.getKey.push(new Date());
  const cookies = parseCookies(req);
  if (cookies.wik_token && tokenToKey.has(cookies.wik_token)) {
    const k = tokenToKey.get(cookies.wik_token);
    const data = keys.get(k);
    return renderKeyPage(res, k, data);
  }

  const stepsJson = JSON.stringify(CONFIG.CHECKPOINTS || []);
  res.send(`
  <!doctype html><html><head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Checkpoint</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
    <style>
      :root { --bg-1:#0f172a; --bg-2:#1e1b4b; --bg-3:#312e81; --bg-4:#1e293b; --surface: rgba(15,23,42,0.72); --border: rgba(148,163,184,0.12); }
      @keyframes gradient { 0%{background-position:0% 50%} 50%{background-position:100% 50%} 100%{background-position:0% 50%} }
      body { background: linear-gradient(-45deg, var(--bg-1), var(--bg-2), var(--bg-3), var(--bg-4)); background-size: 400% 400%; animation: gradient 15s ease infinite; font-family: Inter, ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica Neue, Arial, "Noto Sans", "Apple Color Emoji", "Segoe UI Emoji"; }
      .glass { background: var(--surface); backdrop-filter: blur(20px); border: 1px solid var(--border); }
      @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
      .pulse-dot { animation: pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite; }
      @keyframes slideIn { from { opacity: 0; transform: translateY(10px);} to { opacity: 1; transform: translateY(0);} }
      .slide-in { animation: slideIn 0.5s ease-out; }
      .btn { display:inline-flex; align-items:center; justify-content:center; padding:0.5rem 1rem; border-radius:0.75rem; font-weight:600; transition:all .2s; text-decoration:none }
      .btn-primary { color:#fff; background: linear-gradient(90deg, #3b82f6, #9333ea); box-shadow:0 10px 30px rgba(59,130,246,.25) }
      .btn-muted { background: rgba(71,85,105,.7); color:#e5e7eb }
    </style>
  </head>
  <body class="flex items-center justify-center min-h-screen p-4 text-white">
    <div class="max-w-2xl w-full space-y-6 slide-in">
      <div class="text-center">
        <div class="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-gradient-to-br from-emerald-500 to-blue-600 mb-4 shadow-2xl shadow-emerald-500/30">
          <svg class="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"/>
          </svg>
        </div>
        <h1 class="text-3xl font-bold mb-2">Security Checkpoint</h1>
        <p class="text-slate-400">Complete the verification steps to continue</p>
      </div>

      <div class="glass rounded-2xl p-6 shadow-2xl">
        <div class="flex items-center justify-between mb-6">
          <div>
            <h2 class="text-xl font-semibold">Verification Required</h2>
            <p class="text-slate-400 text-sm mt-1">Follow steps below to proceed</p>
          </div>
          <div class="flex items-center gap-2 text-emerald-400 text-sm px-3 py-1.5 rounded-full bg-emerald-500/10">
            <span class="w-2 h-2 rounded-full bg-emerald-400 pulse-dot"></span>
            Secure
          </div>
        </div>

        <div id="steps"></div>

        <form method="POST" action="/yt-done" class="mt-6">
          <button id="confirm-btn" disabled class="btn btn-muted w-full">
            Continue to Next Step
          </button>
        </form>
      </div>

      <div class="text-center text-slate-500 text-sm">
        <p>🔒 Protected by advanced security measures</p>
      </div>
    </div>

    <script>
      const stepsData = ${stepsJson};
      const container = document.getElementById('steps');
      const confirmBtn = document.getElementById('confirm-btn');
      let idx = 0;
      let timer = null;
      let remaining = 0;

      function renderStep() {
        const s = stepsData[idx];
        if (!s) { confirmBtn.disabled = false; confirmBtn.className = 'btn btn-primary w-full'; return; }
        const num = idx + 1;
        function iconFor(t){ return t==='youtube'?'red': t==='telegram'?'sky': t==='discord'?'indigo': t==='workink'?'purple': t==='lootlab'?'amber': t==='linkverse'?'fuchsia':'blue'; }
        if (s && s.kind === 'group' && Array.isArray(s.items)) {
          const modeAny = s.mode !== 'all';
          const items = s.items;
          let rows = '';
          for (let i=0;i<items.length;i++){
            const it = items[i]||{};
            const t = (String(it.type||'link')==='link' && /lootlab|linkverse/i.test(String(it.url||''))) ? (String(it.url).toLowerCase().indexOf('lootlab')>=0?'lootlab':'linkverse') : String(it.type||'link');
            const icon = iconFor(t);
            const tail = icon==='red'?'pink':'purple';
            const label = it.label || (t==='youtube'?'Subscribe on YouTube': t==='telegram'?'Join Telegram': t==='discord'?'Join Discord': t==='workink'?'Open Work.ink': t==='lootlab'?'Open LootLab': t==='linkverse'?'Open Linkverse':'Open Link');
            const btnTitle = t==='workink'?'Open Work.ink Verification':'Open';
            const actId = 'g-action-'+i;
            rows += '<div class="glass rounded-xl p-4 border border-slate-700/50">'+
              '<div class="flex items-center gap-4">'+
                '<div class="flex-shrink-0 w-12 h-12 rounded-lg bg-gradient-to-br from-'+icon+'-500 to-'+tail+'-600"></div>'+
                '<div class="flex-1">'+
                  '<div class="text-sm font-semibold mb-1">'+label+'</div>'+
                  '<div class="text-xs text-slate-400">'+(it.duration?('Stay for '+it.duration+'s'):'Click to start')+'</div>'+
                '</div>'+
                (it.url ? ('<a id="'+actId+'" href="'+it.url+'" target="_blank" class="btn btn-muted">'+btnTitle+'</a>') : ('<button id="'+actId+'" class="btn btn-muted">Start</button>'))+
              '</div>'+
              (it.duration?('<div class="mt-2 glass rounded-xl p-3 border border-amber-500/30 bg-amber-500/5"><div class="flex items-center justify-between"><p class="text-xs font-semibold text-amber-100">Timer</p><span id="g-timer-'+i+'" class="text-lg font-bold text-amber-100">'+it.duration+'</span></div></div>'):'')+
            '</div>';
          }
          container.innerHTML = '<div class="space-y-4">'+
            '<div class="flex items-center gap-2 text-xs font-semibold text-slate-500 uppercase tracking-wider">'+
              '<div class="w-6 h-6 rounded-full bg-blue-500/20 text-blue-400 flex items-center justify-center">'+num+'</div>'+
              '<p>Step '+num+' ('+(modeAny?'any':'all')+')</p>'+
            '</div>'+
            rows+
          '</div>';
          const done = new Array(items.length).fill(false);
          function check(){ if (modeAny ? done.some(Boolean) : done.every(Boolean)) completeStep(); }
          for (let i=0;i<items.length;i++){
            const it = items[i]||{};
            const act = document.getElementById('g-action-'+i);
            if (!act) continue;
            act.addEventListener('click', () => {
              if (it.duration){
                let rem = it.duration;
                const tmEl = document.getElementById('g-timer-'+i);
                const tmr = setInterval(()=>{
                  rem--; if (tmEl) tmEl.textContent = String(Math.max(rem,0));
                  if (rem<=0){ clearInterval(tmr); done[i]=true; check(); }
                },1000);
              } else { done[i]=true; check(); }
            }, { once: true });
          }
          return;
        }
        const tt = (String(s.type||'link')==='link' && /lootlab|linkverse/i.test(String(s.url||''))) ? (String(s.url).toLowerCase().indexOf('lootlab')>=0?'lootlab':'linkverse') : String(s.type||'link');
        const title = s.label || (tt === 'youtube' ? 'Subscribe on YouTube' : tt === 'telegram' ? 'Join Telegram' : tt === 'discord' ? 'Join Discord' : tt === 'workink' ? 'Complete Work.ink Task' : tt === 'lootlab' ? 'Open LootLab' : tt === 'linkverse' ? 'Open Linkverse' : 'Open Link');
        const btnTitle = tt === 'workink' ? 'Open Work.ink Verification' : 'Open';
        const icon = iconFor(tt);
        const colorTail = icon === 'red' ? 'pink' : 'purple';
        const actionHtml = s.url
          ? '<a id="action-btn" href="' + s.url + '" target="_blank" class="btn btn-muted">' + btnTitle + '</a>'
          : '<button id="action-btn" class="btn btn-muted">Start</button>';
        container.innerHTML =
          '<div class="space-y-4">' +
            '<div class="flex items-center gap-2 text-xs font-semibold text-slate-500 uppercase tracking-wider">' +
              '<div class="w-6 h-6 rounded-full bg-blue-500/20 text-blue-400 flex items-center justify-center">' + num + '</div>' +
              '<p>Step ' + num + '</p>' +
            '</div>' +
            '<div class="glass rounded-xl p-5 border border-slate-700/50">' +
              '<div class="flex items-center gap-4">' +
                '<div class="flex-shrink-0 w-14 h-14 rounded-xl bg-gradient-to-br from-' + icon + '-500 to-' + colorTail + '-600 flex items-center justify-center shadow-lg shadow-' + icon + '-500/30"></div>' +
                '<div class="flex-1">' +
                  '<div class="text-base font-semibold mb-1">' + title + '</div>' +
                  '<div id="desc" class="text-sm text-slate-400">Click the button to start' + (s.duration ? ', stay for ' + s.duration + 's' : '') + '</div>' +
                '</div>' +
                actionHtml +
              '</div>' +
            '</div>' +
            (s.duration
              ? '<div id="wait-box" class="mt-2 glass rounded-xl p-4 border border-amber-500/30 bg-amber-500/5">' +
                  '<div class="flex items-center justify-between">' +
                    '<div>' +
                      '<p id="wait-title" class="text-sm font-semibold text-amber-100">Waiting...</p>' +
                      '<p id="wait-desc" class="text-sm text-slate-300 mt-1">Stay on page</p>' +
                    '</div>' +
                    '<div class="text-right">' +
                      '<span id="wait-timer" class="text-2xl font-bold text-amber-100">' + s.duration + '</span>' +
                      '<p class="text-xs text-slate-400 mt-1">seconds</p>' +
                    '</div>' +
                  '</div>' +
                '</div>'
              : ''
            ) +
          '</div>';
        const actionBtn = document.getElementById('action-btn');
        actionBtn.addEventListener('click', () => {
          if (s.duration) startTimer(s.duration);
          else completeStep();
        }, { once: true });
      }

      function startTimer(sec) {
        const waitTitle = document.getElementById('wait-title');
        const waitDesc = document.getElementById('wait-desc');
        const waitTimer = document.getElementById('wait-timer');
        remaining = sec;
        waitTitle.textContent = 'Timer started...';
        waitDesc.textContent = 'Please stay on the page';
        timer = setInterval(() => {
          remaining--;
          if (remaining > 0) {
            waitTimer.textContent = remaining;
          } else {
            clearInterval(timer);
            completeStep();
          }
        }, 1000);
      }

      function completeStep() {
        confirmBtn.disabled = false;
        confirmBtn.className = 'btn btn-primary w-full';
        confirmBtn.textContent = idx + 1 >= stepsData.length ? 'Continue to Work.ink' : 'Continue';
        confirmBtn.onclick = () => {
          idx++;
          confirmBtn.disabled = true;
          confirmBtn.className = 'btn btn-muted w-full';
          if (idx >= stepsData.length) {
            document.forms[0].submit();
          } else {
            renderStep();
          }
        };
      }

      renderStep();
    </script>
  </body></html>
  `);
});

app.post("/yt-done", strictLimiter, (req, res) => {
  traffic.checkpoint.push(new Date());
  res.send(`
  <!doctype html><html><head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Step 2</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
    <style>
      :root { --bg-1:#0f172a; --bg-2:#1e1b4b; --bg-3:#312e81; --bg-4:#1e293b; --surface: rgba(15,23,42,0.72); --border: rgba(148,163,184,0.12); }
      @keyframes gradient { 0%{background-position:0% 50%} 50%{background-position:100% 50%} 100%{background-position:0% 50%} }
      body { background: linear-gradient(-45deg, var(--bg-1), var(--bg-2), var(--bg-3), var(--bg-4)); background-size: 400% 400%; animation: gradient 15s ease infinite; font-family: Inter, ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica Neue, Arial, "Noto Sans", "Apple Color Emoji", "Segoe UI Emoji"; }
      .glass { background: var(--surface); backdrop-filter: blur(20px); border: 1px solid var(--border); }
    </style>
  </head><body class="flex items-center justify-center min-h-screen p-4">
    <div class="max-w-lg w-full space-y-6">
      <div class="text-center">
        <div class="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-gradient-to-br from-purple-500 to-pink-600 mb-4 shadow-2xl shadow-purple-500/30">
          <svg class="w-8 h-8 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z"/>
          </svg>
        </div>
        <h1 class="text-3xl font-bold text-white mb-2">Almost There!</h1>
        <p class="text-slate-400">One more step to get your key</p>
      </div>

      <div class="glass rounded-2xl p-8 shadow-2xl text-center space-y-6">
        <div class="inline-flex items-center justify-center w-12 h-12 rounded-xl bg-gradient-to-br from-blue-500 to-purple-600">
          <span class="text-2xl font-bold text-white">2</span>
        </div>
        
        <div>
          <h2 class="text-2xl font-bold text-white mb-3">Complete Work.ink Task</h2>
          <p class="text-slate-300 leading-relaxed">After completing the Work.ink verification, you'll be automatically redirected back here with your access key.</p>
        </div>
        
        <div class="bg-slate-900/50 rounded-xl p-4 border border-slate-700">
          <div class="flex items-center gap-3 text-sm text-slate-300">
            <svg class="w-5 h-5 text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>
            </svg>
            <span>Keep this tab open during verification</span>
          </div>
        </div>
        
        <a href="${CONFIG.WORKINK_LINK}" target="_blank" class="inline-block w-full bg-gradient-to-r from-blue-500 to-purple-600 hover:from-blue-600 hover:to-purple-700 py-4 rounded-xl font-semibold shadow-lg shadow-blue-500/30 transition-all transform hover:scale-[1.02] active:scale-[0.98] text-white">
          Open Work.ink Verification
        </a>
      </div>
    </div>
  </body></html>
  `);
});

app.get("/workink-return", strictLimiter, async (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(400).send("No token");

  if (tokenToKey.has(token)) {
    const k = tokenToKey.get(token);
    const data = keys.get(k);
    res.setHeader(
      "Set-Cookie",
      `wik_token=${encodeURIComponent(token)}; Path=/; Max-Age=3600`
    );
    return renderKeyPage(res, k, data);
  }

  try {
    const url = `https://work.ink/_api/v2/token/isValid/${token}?deleteToken=1&forbiddenOnFail=0`;
    const resp = await fetch(url);
    const data = await resp.json();
    if (!data.valid) {
      return res.status(403).send("Work.ink did not validate this token");
    }

    const key = makeKey();
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
    const keyObj = {
      key,
      createdAt: new Date(),
      expiresAt,
      isActive: true,
      usageCount: 0,
      maxUsage: null,
      source: "workink",
      fromWorkInkToken: token,
      hwid: null,
      robloxUserId: null,
      robloxUsername: null,
    };

    keys.set(key, keyObj);
    tokenToKey.set(token, key);
    if (colKeys) {
      try {
        await colKeys.insertOne({
          ...keyObj,
        });
      } catch (e) {
        console.error("Mongo: insert key error", e);
      }
    }
    addEvent("created", key);
    await sendWebhook("Key created (work.ink)", {
      key,
      expiresAt: expiresAt.toISOString(),
      token,
    });

    res.setHeader(
      "Set-Cookie",
      `wik_token=${encodeURIComponent(token)}; Path=/; Max-Age=3600`
    );
    return renderKeyPage(res, key, keyObj);
  } catch (e) {
    console.error(e);
    return res.status(500).send("validate error");
  }
});

app.get("/check", defaultLimiter, async (req, res) => {
  const { key, token, hwid, userId, username } = req.query;

  let realKey = key;
  if (!realKey && token) {
    const found = tokenToKey.get(token);
    if (found) realKey = found;
  }

  let result = { valid: false, reason: "no_key" };

  if (!realKey) {
    checkLogs.push({
      at: new Date(),
      key: null,
      ok: false,
      reason: "no_key",
      hwid,
      userId,
      username,
    });
    return res.json(result);
  }

  const record = keys.get(realKey);
  if (!record) {
    result = { valid: false, reason: "not_found" };
  } else if (!record.isActive) {
    result = { valid: false, reason: "inactive" };
  } else if (record.expiresAt && record.expiresAt < new Date()) {
    result = { valid: false, reason: "expired" };
  } else if (record.maxUsage && (record.usageCount || 0) >= record.maxUsage) {
    result = { valid: false, reason: "limit_reached" };
  } else {
    record.usageCount = (record.usageCount || 0) + 1;
    if (hwid && !record.hwid) record.hwid = hwid;
    if (userId && !record.robloxUserId) {
      record.robloxUserId = userId;
      record.robloxUsername = username || null;
    }
    if (colKeys) {
      try {
        await colKeys.updateOne(
          { key: record.key },
          {
            $set: {
              usageCount: record.usageCount,
              hwid: record.hwid ?? null,
              robloxUserId: record.robloxUserId ?? null,
              robloxUsername: record.robloxUsername ?? null,
            },
          }
        );
      } catch (e) {
        console.error("Mongo: update usage error", e);
      }
    }
    addEvent("used", realKey);
    result = { valid: true };
  }

  checkLogs.push({
    at: new Date(),
    key: realKey,
    ok: result.valid,
    reason: result.reason,
    hwid,
    userId,
    username,
  });
  if (checkLogs.length > 300) checkLogs.shift();
  if (colChecks) {
    try {
      await colChecks.insertOne({
        at: new Date(),
        key: realKey,
        ok: result.valid,
        reason: result.reason,
        hwid,
        userId,
        username,
      });
    } catch (e) {
      console.error("Mongo: insert check error", e);
    }
  }

  return res.json(result);
});

app.get("/admin", requireAdmin, async (req, res) => {
  const pass = req.query.pass;
  const page = req.query.page || "overview";
  const q = (req.query.q || "").toLowerCase();
  const filter = req.query.filter || "all";
  const rangeDays = Math.min(Math.max(parseInt(req.query.range || "30", 10), 1), 30);

  const cookies = parseCookies(req);
  let csrfToken = cookies.csrf_token;
  if (!csrfToken) {
    csrfToken = crypto.randomBytes(16).toString("hex");
    res.setHeader("Set-Cookie", `csrf_token=${csrfToken}; Path=/; HttpOnly; SameSite=Lax`);
  }

  let list = Array.from(keys.values());

  if (filter === "active") {
    list = list.filter(
      (k) => k.isActive && (!k.expiresAt || k.expiresAt > new Date())
    );
  } else if (filter === "expired") {
    list = list.filter((k) => k.expiresAt && k.expiresAt < new Date());
  } else if (filter === "workink") {
    list = list.filter((k) => k.source === "workink");
  } else if (filter === "admin") {
    list = list.filter((k) => k.source === "admin");
  }

  if (q) {
    list = list.filter((k) => {
      return (
        (k.key && k.key.toLowerCase().includes(q)) ||
        (k.robloxUsername && k.robloxUsername.toLowerCase().includes(q)) ||
        (k.robloxUserId && String(k.robloxUserId).includes(q)) ||
        (k.fromWorkInkToken && k.fromWorkInkToken.includes(q))
      );
    });
  }

  list.sort((a, b) => {
    const at = a.createdAt ? a.createdAt.getTime() : 0;
    const bt = b.createdAt ? b.createdAt.getTime() : 0;
    return bt - at;
  });

  const clicks = countArrayInRange(traffic.getKey, rangeDays);
  const checkpoints = countArrayInRange(traffic.checkpoint, rangeDays);
  const keysGenerated = countEventsInRange(rangeDays, "created");
  const keysUsed = countEventsInRange(rangeDays, "used");
  const scriptExecutions = checkLogs.filter(
    (l) => l.at.getTime() >= Date.now() - rangeDays * 86400000
  ).length;

  const nowMidnight = new Date(); nowMidnight.setHours(0,0,0,0);
  function countDay(arr, start){
    const end = new Date(start.getTime() + 86400000);
    let c = 0; for (const d of arr) { const t = d.getTime(); if (t >= start.getTime() && t < end.getTime()) c++; }
    return c;
  }
  function countDayEvents(type, start){
    const end = new Date(start.getTime() + 86400000);
    let c = 0; for (const e of events) { if (type && e.type !== type) continue; const t = e.at.getTime(); if (t >= start.getTime() && t < end.getTime()) c++; }
    return c;
  }
  function countDayChecks(start){
    const end = new Date(start.getTime() + 86400000);
    let c = 0; for (const l of checkLogs) { const t = l.at.getTime(); if (t >= start.getTime() && t < end.getTime()) c++; }
    return c;
  }
  const sClicks = []; const sCheckpoints = []; const sGenerated = []; const sUsed = []; const sExec = []; const sKeys = [];
  for (let i = rangeDays - 1; i >= 0; i--) {
    const dayStart = new Date(nowMidnight.getTime() - i * 86400000);
    sClicks.push(countDay(traffic.getKey, dayStart));
    sCheckpoints.push(countDay(traffic.checkpoint, dayStart));
    sGenerated.push(countDayEvents("created", dayStart));
    sUsed.push(countDayEvents("used", dayStart));
    sExec.push(countDayChecks(dayStart));
    sKeys.push(countDayEvents("created", dayStart));
  }
  const prevClicks = countArrayInRange(traffic.getKey, rangeDays * 2) - clicks;
  const prevCheckpoints = countArrayInRange(traffic.checkpoint, rangeDays * 2) - checkpoints;
  const prevGenerated = countEventsInRange(rangeDays * 2, "created") - keysGenerated;
  const growth = {
    clicks: prevClicks ? ((clicks - prevClicks) / Math.max(1, prevClicks)) * 100 : 0,
    checkpoints: prevCheckpoints ? ((checkpoints - prevCheckpoints) / Math.max(1, prevCheckpoints)) * 100 : 0,
    generated: prevGenerated ? ((keysGenerated - prevGenerated) / Math.max(1, prevGenerated)) * 100 : 0
  };
  const usageRate = keysGenerated ? Math.min(100, Math.round((keysUsed / keysGenerated) * 100)) : 0;

  const totalKeys = keys.size;
  const totalChecks = checkLogs.length;

  // ВАЖЛИВО: Генеруємо pageContent залежно від сторінки
  let pageContent = "";
  
  if (page === "keys") {
    const totalCount = list.length;
    const activeCount = Array.from(keys.values()).filter((k) => k.isActive && (!k.expiresAt || k.expiresAt > new Date())).length;
    const expiredCount = Array.from(keys.values()).filter((k) => k.expiresAt && k.expiresAt < new Date()).length;
    const usageRateKeysGen = countEventsInRange(rangeDays, "created");
    const usageRateKeysUsed = countEventsInRange(rangeDays, "used");
    const usageRateSummary = usageRateKeysGen ? Math.min(100, Math.round((usageRateKeysUsed / usageRateKeysGen) * 100)) : 0;

    const pageSize = Math.min(50, Math.max(5, parseInt(req.query.pageSize || "20", 10)));
    const pageNum = Math.max(1, parseInt(req.query.p || "1", 10));
    const pages = Math.max(1, Math.ceil(totalCount / pageSize));
    const start = (pageNum - 1) * pageSize;
    const end = start + pageSize;
    const paged = list.slice(start, end);

    pageContent = renderKeysPage(pass, rangeDays, q, filter, paged, csrfToken, {
      total: totalCount,
      active: activeCount,
      expired: expiredCount,
      usageRate: usageRateSummary,
      page: pageNum,
      pages
    });
  } else if (page === "services") {
    pageContent = renderServicesPageImpl(pass, csrfToken, CONFIG, KEY_BACKEND);
  } else if (page === "scripts") {
    let scriptsList = [];
    if (colScripts) {
      try {
        scriptsList = await colScripts.find({}).sort({ createdAt: -1 }).limit(10).toArray();
      } catch {}
    }
    pageContent = renderScriptsPageImpl(req, pass, csrfToken, scriptsList);
  } else if (page === "webhooks") {
    pageContent = renderWebhooksPage(pass);
  } else if (page === "settings") {
    pageContent = renderSettingsPage(pass);
  } else {
    pageContent = renderOverviewPageImpl(pass, rangeDays, clicks, checkpoints, totalKeys, keysGenerated, keysUsed, scriptExecutions, totalChecks, list, { clicks: sClicks, checkpoints: sCheckpoints, keys: sKeys, generated: sGenerated, used: sUsed, exec: sExec, usageRate }, growth);
  }

  // Generate HTML
  res.send(`
  <!doctype html>
  <html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Dashboard - Key Management</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
    <style>
      :root { --bg-1:#0f172a; --bg-2:#1e1b4b; --bg-3:#312e81; --bg-4:#1e293b; --surface: rgba(15,23,42,0.72); --border: rgba(148,163,184,0.12); }
      @keyframes gradient { 0%{background-position:0% 50%} 50%{background-position:100% 50%} 100%{background-position:0% 50%} }
      body { background: linear-gradient(-45deg, var(--bg-1), var(--bg-2), var(--bg-3), var(--bg-4)); background-size: 400% 400%; animation: gradient 15s ease infinite; font-family: Inter, ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica Neue, Arial, "Noto Sans", "Apple Color Emoji", "Segoe UI Emoji"; }
      .glass { background: var(--surface); backdrop-filter: blur(20px); border: 1px solid var(--border); }
      .btn { display:inline-flex; align-items:center; justify-content:center; padding:0.5rem 1rem; border-radius:0.75rem; font-weight:600; transition:all .2s; text-decoration:none }
      .btn-primary { color:#fff; background: linear-gradient(90deg, #3b82f6, #9333ea); box-shadow:0 10px 30px rgba(59,130,246,.25) }
      .btn-primary:hover { filter:brightness(1.05) }
      .btn-muted { background: rgba(71,85,105,.7); color:#e5e7eb }
      .btn-muted:hover { background: rgba(71,85,105,.85) }
      .btn-outline-blue { background: rgba(59,130,246,.08); color:#93c5fd; border:1px solid rgba(59,130,246,.2) }
      .btn-outline-blue:hover { background: rgba(59,130,246,.15) }
      .btn-outline-red { background: rgba(239,68,68,.08); color:#fca5a5; border:1px solid rgba(239,68,68,.2) }
      .btn-outline-red:hover { background: rgba(239,68,68,.15) }
      .btn-outline-amber { background: rgba(245,158,11,.08); color:#fcd34d; border:1px solid rgba(245,158,11,.2) }
      .btn-outline-amber:hover { background: rgba(245,158,11,.15) }
      .btn-outline-rose { background: rgba(244,63,94,.08); color:#fda4af; border:1px solid rgba(244,63,94,.2) }
      .btn-outline-rose:hover { background: rgba(244,63,94,.15) }
      .input { width:100%; background: rgba(2,6,23,.5); border:1px solid var(--border); border-radius:0.75rem; padding:0.625rem 0.75rem; font-size:.875rem; color:#fff }
      .input::placeholder { color:#94a3b8 }
      .input:focus { outline:none; border-color:rgba(59,130,246,.4); box-shadow:0 0 0 2px rgba(59,130,246,.35) }
      .sidebar-item {
        display: flex;
        align-items: center;
        gap: 0.75rem;
        padding: 0.75rem 1rem;
        border-radius: 0.75rem;
        color: rgba(148, 163, 184, 0.8);
        text-decoration: none;
        font-size: 0.875rem;
        transition: all 0.2s;
      }
      .sidebar-item:hover {
        background: rgba(59, 130, 246, 0.1);
        color: rgba(255, 255, 255, 0.9);
      }
      .sidebar-item.active {
        background: linear-gradient(135deg, rgba(59, 130, 246, 0.2), rgba(147, 51, 234, 0.2));
        color: white;
        font-weight: 500;
      }
      .stat-card {
        background: rgba(15, 23, 42, 0.7);
        backdrop-filter: blur(20px);
        border: 1px solid rgba(148, 163, 184, 0.1);
        border-radius: 1rem;
        padding: 1.25rem;
        transition: all 0.3s;
      }
      .stat-card:hover {
        transform: translateY(-2px);
        border-color: rgba(59, 130, 246, 0.3);
        box-shadow: 0 10px 30px rgba(59, 130, 246, 0.1);
      }
      .scrollbar::-webkit-scrollbar { width: 8px; height: 8px; }
      .scrollbar::-webkit-scrollbar-track { background: rgba(15, 23, 42, 0.4); border-radius: 10px; }
      .scrollbar::-webkit-scrollbar-thumb { background: rgba(59, 130, 246, 0.3); border-radius: 10px; }
      .scrollbar::-webkit-scrollbar-thumb:hover { background: rgba(59, 130, 246, 0.5); }
    </style>
  </head>
  <body class="text-white min-h-screen flex">
    <!-- Sidebar -->
    <aside class="w-64 glass border-r border-slate-800/50 flex flex-col p-4 flex-shrink-0">
      <div class="flex items-center gap-3 mb-8 pb-4 border-b border-slate-800/50">
        <div class="w-10 h-10 rounded-xl bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center shadow-lg shadow-blue-500/30">
          <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z"/>
          </svg>
        </div>
        <div>
          <p class="font-bold">Key Manager</p>
          <p class="text-xs text-slate-400">Admin Dashboard</p>
        </div>
      </div>
      
      <div class="text-xs uppercase tracking-wider text-slate-500 mb-3 px-2">Navigation</div>
      <div class="space-y-1 flex-1">
        <a href="/admin?pass=${pass}&page=overview" class="sidebar-item ${(!req.query.page || req.query.page === 'overview') ? 'active' : ''}">
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"/>
          </svg>
          Overview
        </a>
        <a href="/admin?pass=${pass}&page=keys" class="sidebar-item ${req.query.page === 'keys' ? 'active' : ''}">
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z"/>
          </svg>
          Keys
        </a>
        <a href="/admin?pass=${pass}&page=scripts" class="sidebar-item ${req.query.page === 'scripts' ? 'active' : ''}">
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"/>
          </svg>
          Scripts
        </a>
        <a href="/admin?pass=${pass}&page=services" class="sidebar-item ${req.query.page === 'services' ? 'active' : ''}">
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10"/>
          </svg>
          Services
        </a>
        <a href="/admin?pass=${pass}&page=webhooks" class="sidebar-item ${req.query.page === 'webhooks' ? 'active' : ''}">
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z"/>
          </svg>
          Webhooks
        </a>
        <a href="/admin?pass=${pass}&page=settings" class="sidebar-item ${req.query.page === 'settings' ? 'active' : ''}">
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"/>
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/>
          </svg>
          Settings
        </a>
      </div>
      
      <div class="pt-4 mt-auto border-t border-slate-800/50">
        <div class="flex items-center gap-3 px-2">
          <div class="w-8 h-8 rounded-full bg-gradient-to-br from-emerald-500 to-blue-600 flex items-center justify-center text-xs font-bold">A</div>
          <div class="flex-1 min-w-0">
            <p class="text-sm font-medium truncate">Admin</p>
            <p class="text-xs text-slate-500">Logged in</p>
          </div>
        </div>
      </div>
    </aside>

    <!-- Main Content -->
    <main class="flex-1 min-h-screen overflow-auto">
      ${pageContent}
    </main>
  </body>
  </html>
  `);
});

app.get("/admin/export-keys.csv", requireAdmin, (req, res) => {
  const pass = req.query.pass;
  const q = (req.query.q || "").toLowerCase();
  const filter = req.query.filter || "all";
  let list = Array.from(keys.values());
  if (filter === "active") list = list.filter((k) => k.isActive && (!k.expiresAt || k.expiresAt > new Date()));
  else if (filter === "expired") list = list.filter((k) => k.expiresAt && k.expiresAt < new Date());
  else if (filter === "workink") list = list.filter((k) => k.source === "workink");
  else if (filter === "admin") list = list.filter((k) => k.source === "admin");
  if (q) {
    list = list.filter((k) => (k.key && k.key.toLowerCase().includes(q)) || (k.robloxUsername && k.robloxUsername.toLowerCase().includes(q)) || (k.robloxUserId && String(k.robloxUserId).includes(q)) || (k.fromWorkInkToken && k.fromWorkInkToken.includes(q)));
  }
  list.sort((a,b)=>{ const at=a.createdAt? a.createdAt.getTime():0; const bt=b.createdAt? b.createdAt.getTime():0; return bt-at; });
  const header = ['key','createdAt','expiresAt','isActive','usageCount','maxUsage','robloxUserId','robloxUsername','source','hwid'];
  const lines = [header.join(',')].concat(list.map(k => [
    k.key,
    k.createdAt ? k.createdAt.toISOString() : '',
    k.expiresAt ? k.expiresAt.toISOString() : '',
    k.isActive ? '1' : '0',
    k.usageCount ?? 0,
    k.maxUsage ?? '',
    k.robloxUserId ?? '',
    (k.robloxUsername ?? '').replace(/,/g,' '),
    k.source ?? '',
    (k.hwid ?? '').replace(/,/g,' ')
  ].join(',')));
  res.setHeader('Content-Type','text/csv; charset=utf-8');
  res.setHeader('Content-Disposition','attachment; filename="keys.csv"');
  res.send(lines.join('\n'));
});

app.post("/admin/create-key", requireAdmin, async (req, res) => {
  const pass = req.body.pass || req.query.pass || ADMIN_PASSWORD;
  const cookies = parseCookies(req);
  const csrfBody = req.body.csrf;
  if (!cookies.csrf_token || cookies.csrf_token !== csrfBody) {
    return res.status(403).send("Invalid CSRF");
  }
  const customKey = (req.body.customKey || "").trim();
  const hours = Number(req.body.hours || 1);
  const maxUsage = req.body.maxUsage ? Number(req.body.maxUsage) : null;
  const robloxUserId = (req.body.robloxUserId || "").trim();
  const robloxUsername = (req.body.robloxUsername || "").trim();
  const hwid = (req.body.hwid || "").trim();

  const key = customKey !== "" ? customKey.toUpperCase() : makeKey();
  const expiresAt = new Date(Date.now() + hours * 60 * 60 * 1000);

  const keyObj = {
    key,
    createdAt: new Date(),
    expiresAt,
    isActive: true,
    usageCount: 0,
    maxUsage: maxUsage && maxUsage > 0 ? maxUsage : null,
    source: "admin",
    fromWorkInkToken: null,
    hwid: hwid !== "" ? hwid : null,
    robloxUserId: robloxUserId !== "" ? robloxUserId : null,
    robloxUsername: robloxUsername !== "" ? robloxUsername : null,
  };

  keys.set(key, keyObj);
  if (colKeys) {
    try {
      await colKeys.insertOne({ ...keyObj });
    } catch (e) {
      console.error("Mongo: insert key error", e);
    }
  }
  addEvent("created", key);
  await sendWebhook("Key created (admin)", {
    key,
    expiresAt: expiresAt.toISOString(),
    maxUsage: keyObj.maxUsage,
    robloxUserId,
    robloxUsername,
  });

  res.redirect("/admin?pass=" + encodeURIComponent(pass));
});

app.post("/admin/action", requireAdmin, async (req, res) => {
  const pass = req.body.pass || req.query.pass || ADMIN_PASSWORD;
  const cookies = parseCookies(req);
  const csrfBody = req.body.csrf;
  if (!cookies.csrf_token || cookies.csrf_token !== csrfBody) {
    return res.status(403).send("Invalid CSRF");
  }
  const { action, key } = req.body;
  const item = keys.get(key);
  if (!item) {
    return res.redirect("/admin?pass=" + encodeURIComponent(pass));
  }

  if (action === "deactivate") {
    item.isActive = false;
    if (colKeys) {
      try { await colKeys.updateOne({ key }, { $set: { isActive: false } }); } catch (e) { console.error("Mongo: deactivate error", e); }
    }
  } else if (action === "delete") {
    keys.delete(key);
    for (const [tok, k] of tokenToKey.entries()) {
      if (k === key) tokenToKey.delete(tok);
    }
    if (colKeys) {
      try { await colKeys.deleteOne({ key }); } catch (e) { console.error("Mongo: delete error", e); }
    }
  } else if (action === "extend1h") {
    const base =
      item.expiresAt && item.expiresAt > new Date() ? item.expiresAt : new Date();
    item.expiresAt = new Date(base.getTime() + 1 * 60 * 60 * 1000);
    if (colKeys) {
      try { await colKeys.updateOne({ key }, { $set: { expiresAt: item.expiresAt } }); } catch (e) { console.error("Mongo: extend1h error", e); }
    }
  } else if (action === "extend24h") {
    const base =
      item.expiresAt && item.expiresAt > new Date() ? item.expiresAt : new Date();
    item.expiresAt = new Date(base.getTime() + 24 * 60 * 60 * 1000);
    if (colKeys) {
      try { await colKeys.updateOne({ key }, { $set: { expiresAt: item.expiresAt } }); } catch (e) { console.error("Mongo: extend24h error", e); }
    }
  }

  res.redirect("/admin?pass=" + encodeURIComponent(pass));
});

app.post("/admin/upload-script", requireAdmin, async (req, res) => {
  const pass = req.body.pass || req.query.pass || ADMIN_PASSWORD;
  const cookies = parseCookies(req);
  const csrfBody = req.body.csrf;
  if (!cookies.csrf_token || cookies.csrf_token !== csrfBody) {
    return res.status(403).send("Invalid CSRF");
  }
  const content = String(req.body.script || req.body.content || "");
  const name = String(req.body.name || "").trim();
  const description = String(req.body.description || "").trim();
  if (!content.trim()) {
    return res.redirect("/admin?pass=" + encodeURIComponent(pass) + "&page=scripts");
  }
  const originalCode = content;
  const obfuscatedCode = obfuscateLua(originalCode);
  currentScript = { content: obfuscatedCode, updatedAt: new Date() };
  if (colScripts) {
    try {
      await colScripts.updateMany({}, { $set: { isActive: false } });
      const publicToken = crypto.randomBytes(16).toString("hex");
      await colScripts.insertOne({ name: name || "Untitled", description, originalCode, obfuscatedCode, publicToken, createdAt: new Date(), updatedAt: new Date(), isActive: true });
    } catch (e) {
      console.error("Mongo: upload script error", e);
    }
  }
  res.redirect("/admin?pass=" + encodeURIComponent(pass) + "&page=scripts");
});

app.post("/admin/script-action", requireAdmin, async (req, res) => {
  const pass = req.body.pass || req.query.pass || ADMIN_PASSWORD;
  const cookies = parseCookies(req);
  const csrfBody = req.body.csrf;
  if (!cookies.csrf_token || cookies.csrf_token !== csrfBody) {
    return res.status(403).send("Invalid CSRF");
  }
  const action = String(req.body.action || "");
  const id = req.body.id ? String(req.body.id) : null;
  if (action === "deactivate") {
    currentScript = null;
    if (colScripts) {
      try { await colScripts.updateMany({}, { $set: { isActive: false } }); } catch {}
    }
  } else if (action === "activate" && id && colScripts) {
    try {
      await colScripts.updateMany({}, { $set: { isActive: false } });
      await colScripts.updateOne({ _id: new ObjectId(id) }, { $set: { isActive: true } });
      const doc = await colScripts.findOne({ _id: new ObjectId(id) });
      currentScript = { content: doc?.content || "", updatedAt: new Date() };
    } catch (e) { console.error("Mongo: activate script error", e); }
  } else if (action === "delete" && id && colScripts) {
    try {
      const doc = await colScripts.findOne({ _id: new ObjectId(id) });
      await colScripts.deleteOne({ _id: new ObjectId(id) });
      if (doc?.isActive) {
        const latest = await colScripts.find({}).sort({ createdAt: -1 }).limit(1).toArray();
        if (latest[0]) {
          await colScripts.updateOne({ _id: latest[0]._id }, { $set: { isActive: true } });
          currentScript = { content: latest[0].content, updatedAt: latest[0].createdAt };
        } else {
          currentScript = null;
        }
      }
    } catch (e) { console.error("Mongo: delete script error", e); }
  }
  res.redirect("/admin?pass=" + encodeURIComponent(pass) + "&page=scripts");
});

app.get("/admin/download-script", requireAdmin, (req, res) => {
  const content = currentScript?.content || "";
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Content-Disposition", "attachment; filename=script.lua");
  res.send(content);
});

app.post("/admin/update-config", requireAdmin, async (req, res) => {
  const pass = req.body.pass || req.query.pass || ADMIN_PASSWORD;
  const cookies = parseCookies(req);
  const csrfBody = req.body.csrf;
  if (!cookies.csrf_token || cookies.csrf_token !== csrfBody) {
    return res.status(403).send("Invalid CSRF");
  }
  const { WORKINK_LINK, YT_CHANNEL, DISCORD_WEBHOOK_URL, KEY_BACKEND: KB, CHECKPOINTS_JSON } = req.body;
  if (typeof WORKINK_LINK === "string") CONFIG.WORKINK_LINK = WORKINK_LINK.trim();
  if (typeof YT_CHANNEL === "string") CONFIG.YT_CHANNEL = YT_CHANNEL.trim();
  if (typeof DISCORD_WEBHOOK_URL === "string") CONFIG.DISCORD_WEBHOOK_URL = DISCORD_WEBHOOK_URL.trim();
  if (typeof KB === "string" && KB.trim() !== "") KEY_BACKEND = KB.trim();
  if (typeof CHECKPOINTS_JSON === "string") {
    try {
      const parsed = JSON.parse(CHECKPOINTS_JSON);
      if (Array.isArray(parsed)) {
        CONFIG.CHECKPOINTS = parsed.slice(0, 20);
      }
    } catch (e) {}
  }
  if (colConfig) {
    try {
      await colConfig.updateOne(
        { _id: "main" },
        { $set: { WORKINK_LINK: CONFIG.WORKINK_LINK, YT_CHANNEL: CONFIG.YT_CHANNEL, DISCORD_WEBHOOK_URL: CONFIG.DISCORD_WEBHOOK_URL, KEY_BACKEND: KEY_BACKEND, CHECKPOINTS: CONFIG.CHECKPOINTS } },
        { upsert: true }
      );
    } catch (e) {
      console.error("Mongo: update config error", e);
    }
  }
  saveLocalConfig();
  res.redirect("/admin?pass=" + encodeURIComponent(pass) + "&page=services");
});

app.get("/admin/delete-expired", requireAdmin, async (req, res) => {
  const pass = req.query.pass || ADMIN_PASSWORD;
  const now = new Date();
  for (const [k, v] of keys.entries()) {
    if (v.expiresAt && v.expiresAt < now) {
      keys.delete(k);
    }
  }
  if (colKeys) {
    try { await colKeys.deleteMany({ expiresAt: { $lt: now } }); } catch (e) {}
  }
  res.redirect("/admin?pass=" + encodeURIComponent(pass));
});

function renderKeyPage(res, key, keyData) {
  const expired = keyData.expiresAt && keyData.expiresAt < new Date();
  const created =
    keyData.createdAt && keyData.createdAt.toISOString
      ? keyData.createdAt.toISOString().replace("T", " ").slice(0, 19)
      : "—";
  const exp =
    keyData.expiresAt && keyData.expiresAt.toISOString
      ? keyData.expiresAt.toISOString().replace("T", " ").slice(0, 19)
      : "—";

  res.send(`
  <!doctype html><html><head>
    <meta charset="utf-8"/>
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Your Key</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
    <style>
      :root { --bg-1:#0f172a; --bg-2:#1e1b4b; --bg-3:#312e81; --bg-4:#1e293b; --surface: rgba(15,23,42,0.72); --border: rgba(148,163,184,0.12); }
      @keyframes gradient { 0%{background-position:0% 50%} 50%{background-position:100% 50%} 100%{background-position:0% 50%} }
      body { background: linear-gradient(-45deg, var(--bg-1), var(--bg-2), var(--bg-3), var(--bg-4)); background-size: 400% 400%; animation: gradient 15s ease infinite; font-family: Inter, ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica Neue, Arial, "Noto Sans", "Apple Color Emoji", "Segoe UI Emoji"; }
      .glass { background: var(--surface); backdrop-filter: blur(20px); border: 1px solid var(--border); }
      @keyframes slideIn {
        from {
          opacity: 0;
          transform: translateY(20px);
        }
        to {
          opacity: 1;
          transform: translateY(0);
        }
      }
      .slide-in {
        animation: slideIn 0.6s ease-out;
      }
      @keyframes float {
        0%, 100% { transform: translateY(0px); }
        50% { transform: translateY(-10px); }
      }
      .float {
        animation: float 3s ease-in-out infinite;
      }
    </style>
  </head><body class="flex items-center justify-center min-h-screen p-4 text-white">
    <div class="max-w-2xl w-full space-y-6 slide-in">
      <!-- Success Badge -->
      <div class="text-center">
        <div class="inline-flex items-center justify-center w-20 h-20 rounded-2xl ${expired ? "bg-gradient-to-br from-rose-500 to-pink-600 shadow-2xl shadow-rose-500/40" : "bg-gradient-to-br from-emerald-500 to-blue-600 shadow-2xl shadow-emerald-500/40"} mb-4 float">
          <svg class="w-10 h-10" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            ${expired 
              ? '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>'
              : '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"/>'}
          </svg>
        </div>
        <h1 class="text-3xl font-bold mb-2">${expired ? "Key Expired" : "Success!"}</h1>
        <p class="text-slate-400">${expired ? "This key has expired but has been generated" : "Your access key has been generated successfully"}</p>
      </div>

      <!-- Status Card -->
      <div class="glass rounded-2xl p-6 shadow-2xl">
        <div class="flex items-center justify-between mb-6">
          <div class="flex items-center gap-3">
            <div class="w-12 h-12 rounded-xl ${expired ? "bg-rose-500/10" : "bg-emerald-500/10"} flex items-center justify-center">
              <svg class="w-6 h-6 ${expired ? "text-rose-400" : "text-emerald-400"}" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z"/>
              </svg>
            </div>
            <div>
              <h2 class="text-lg font-semibold">Your Access Key</h2>
              <p class="text-sm text-slate-400">Copy and use in your application</p>
            </div>
          </div>
          <span class="px-3 py-1.5 rounded-full text-xs font-medium ${expired ? "bg-rose-500/10 text-rose-300 border border-rose-500/20" : "bg-emerald-500/10 text-emerald-300 border border-emerald-500/20"}">
            ${expired ? "Expired" : "Active"}
          </span>
        </div>

        <!-- Key Display -->
        <div class="space-y-4">
          <div>
            <label class="block text-xs text-slate-400 mb-2 uppercase tracking-wider">Your Key Code</label>
            <div class="flex gap-3">
              <div class="flex-1 glass rounded-xl px-5 py-4 border ${expired ? "border-rose-400/20" : "border-emerald-400/20"}">
                <code class="text-2xl font-mono font-bold tracking-wider ${expired ? "text-rose-300" : "text-emerald-300"}">${key}</code>
              </div>
              <button onclick="copyKey()" class="px-5 py-3 rounded-xl bg-gradient-to-r from-blue-500 to-purple-600 hover:from-blue-600 hover:to-purple-700 font-medium transition-all transform hover:scale-105 active:scale-95 shadow-lg shadow-blue-500/30">
                <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"/>
                </svg>
              </button>
            </div>
          </div>

          <!-- Details Grid -->
          <div class="grid grid-cols-3 gap-3">
            <div class="glass rounded-xl p-4 border border-slate-700/50">
              <div class="flex items-center gap-2 mb-2">
                <svg class="w-4 h-4 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"/>
                </svg>
                <span class="text-xs text-slate-400 uppercase tracking-wider">Created</span>
              </div>
              <p class="text-sm font-medium text-slate-200">${created}</p>
            </div>
            
            <div class="glass rounded-xl p-4 border border-slate-700/50">
              <div class="flex items-center gap-2 mb-2">
                <svg class="w-4 h-4 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"/>
                </svg>
                <span class="text-xs text-slate-400 uppercase tracking-wider">Expires</span>
              </div>
              <p class="text-sm font-medium ${expired ? "text-rose-300" : "text-slate-200"}">${exp}</p>
            </div>
            
            <div class="glass rounded-xl p-4 border border-slate-700/50">
              <div class="flex items-center gap-2 mb-2">
                <svg class="w-4 h-4 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"/>
                </svg>
                <span class="text-xs text-slate-400 uppercase tracking-wider">Status</span>
              </div>
              <p class="text-sm font-medium ${expired ? "text-rose-300" : "text-emerald-300"}">${expired ? "Expired" : "Valid"}</p>
            </div>
          </div>
        </div>

        ${expired ? `
        <div class="mt-4 flex items-start gap-3 bg-amber-500/5 border border-amber-500/20 rounded-xl p-4">
          <svg class="w-5 h-5 text-amber-400 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/>
          </svg>
          <div>
            <p class="text-sm font-medium text-amber-300 mb-1">Key Expired</p>
            <p class="text-xs text-slate-400">This key has expired and cannot be used. Please generate a new one.</p>
          </div>
        </div>
        ` : `
        <div class="mt-4 flex items-start gap-3 bg-emerald-500/5 border border-emerald-500/20 rounded-xl p-4">
          <svg class="w-5 h-5 text-emerald-400 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"/>
          </svg>
          <div>
            <p class="text-sm font-medium text-emerald-300 mb-1">Key is Active</p>
            <p class="text-xs text-slate-400">Your key is ready to use. Keep it safe and don't share it with others.</p>
          </div>
        </div>
        `}
      </div>

      <!-- Footer -->
      <div class="text-center">
        <p class="text-slate-500 text-sm">🔒 Keep your key secure and private</p>
      </div>
    </div>

    <script>
      function copyKey() {
        navigator.clipboard.writeText('${key}').then(() => {
          const btn = event.target.closest('button');
          const originalHTML = btn.innerHTML;
          btn.innerHTML = '<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/></svg>';
          btn.classList.add('bg-emerald-500', 'hover:bg-emerald-600');
          btn.classList.remove('from-blue-500', 'to-purple-600', 'hover:from-blue-600', 'hover:to-purple-700');
          setTimeout(() => {
            btn.innerHTML = originalHTML;
            btn.classList.remove('bg-emerald-500', 'hover:bg-emerald-600');
            btn.classList.add('bg-gradient-to-r', 'from-blue-500', 'to-purple-600', 'hover:from-blue-600', 'hover:to-purple-700');
          }, 2000);
        });
      }
    </script>
  </body></html>
  `);
}

initDB().finally(() => {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log("server started on " + PORT);
  });
});
app.post("/admin/script-create", requireAdmin, async (req, res) => {
  const pass = req.body.pass || req.query.pass || ADMIN_PASSWORD;
  const cookies = parseCookies(req);
  const csrfBody = req.body.csrf;
  if (!cookies.csrf_token || cookies.csrf_token !== csrfBody) {
    return res.status(403).send("Invalid CSRF");
  }
  const name = String(req.body.name || "").trim();
  const description = String(req.body.description || "").trim();
  const content = String(req.body.content || "").trim();
  if (!name || !content) {
    return res.redirect("/admin?pass=" + encodeURIComponent(pass) + "&page=scripts");
  }
  const originalCode = content;
  const obfuscatedCode = obfuscateLua(originalCode);
  currentScript = { content: obfuscatedCode, updatedAt: new Date() };
  if (colScripts) {
    try {
      await colScripts.updateMany({}, { $set: { isActive: false } });
      const publicToken = crypto.randomBytes(16).toString("hex");
      await colScripts.insertOne({ name, description, originalCode, obfuscatedCode, publicToken, createdAt: new Date(), updatedAt: new Date(), isActive: true });
    } catch (e) { console.error("Mongo: create script error", e); }
  }
  res.redirect("/admin?pass=" + encodeURIComponent(pass) + "&page=scripts");
});

app.post("/admin/script-update", requireAdmin, async (req, res) => {
  const pass = req.body.pass || req.query.pass || ADMIN_PASSWORD;
  const cookies = parseCookies(req);
  const csrfBody = req.body.csrf;
  if (!cookies.csrf_token || cookies.csrf_token !== csrfBody) {
    return res.status(403).send("Invalid CSRF");
  }
  const id = req.body.id ? String(req.body.id) : null;
  if (!id || !colScripts) {
    return res.redirect("/admin?pass=" + encodeURIComponent(pass) + "&page=scripts");
  }
  const name = typeof req.body.name === 'string' ? req.body.name.trim() : undefined;
  const description = typeof req.body.description === 'string' ? req.body.description.trim() : undefined;
  const content = typeof req.body.content === 'string' ? req.body.content : undefined;
  const set = { updatedAt: new Date() };
  if (name !== undefined) set.name = name || "Untitled";
  if (description !== undefined) set.description = description || "";
  if (content !== undefined && content.trim() !== "") { const originalCode = content; const obfuscatedCode = obfuscateLua(originalCode); set.originalCode = originalCode; set.obfuscatedCode = obfuscatedCode; currentScript = { content: obfuscatedCode, updatedAt: new Date() }; }
  try {
    await colScripts.updateOne({ _id: new ObjectId(id) }, { $set: set });
  } catch (e) { console.error("Mongo: update script error", e); }
  res.redirect("/admin?pass=" + encodeURIComponent(pass) + "&page=scripts");
});
