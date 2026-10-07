(function () {
function require(id) {
  switch (id) {
    case "@vendetta": return vendetta;
    case "@vendetta/metro": return vendetta.metro;
    case "@vendetta/metro/common": return vendetta.metro.common;
    case "@vendetta/ui/assets": return vendetta.ui.assets;
    case "@vendetta/ui/toasts": return vendetta.ui.toasts;
    case "@vendetta/ui/components": return vendetta.ui.components;
    case "@vendetta/storage": return vendetta.storage;
    case "@vendetta/plugin": return vendetta.plugin;
    default: throw new Error("[ThreadBlacklist] Unknown module: " + id);
  }
}
var module = { exports: {} };
var exports = module.exports;
'use strict';

Object.defineProperties(exports, { __esModule: { value: true }, [Symbol.toStringTag]: { value: 'Module' } });

const metro = require('@vendetta/metro');
const plugin = require('@vendetta/plugin');
const _vendetta = require('@vendetta');
const common = require('@vendetta/metro/common');
const assets = require('@vendetta/ui/assets');
const toasts = require('@vendetta/ui/toasts');
const components = require('@vendetta/ui/components');
const storage = require('@vendetta/storage');

const { FormSection, FormInput, FormText, FormSwitchRow } = components.Forms;

function Settings() {
  storage.useProxy(plugin.storage);
  const h = common.React.createElement;
  return h(
    FormSection,
    { title: "Thread Blacklist", android_noDivider: true },
    h(FormInput, {
      title: "Blacklisted users",
      placeholder: "User IDs or usernames, separated by commas",
      value: plugin.storage.blacklist,
      onChange: (v) => (plugin.storage.blacklist = v)
    }),
    h(FormInput, {
      title: "Thread channel ID (optional)",
      placeholder: "Channel where threads are created",
      value: plugin.storage.threadChannelId,
      onChange: (v) => (plugin.storage.threadChannelId = v.trim())
    }),
    FormSwitchRow
      ? h(FormSwitchRow, {
          label: "Test mode (don't delete, only show a toast)",
          value: !!plugin.storage.dryRun,
          onValueChange: (v) => (plugin.storage.dryRun = v)
        })
      : null,
    h(
      FormText,
      { style: { paddingHorizontal: 16, paddingBottom: 8 } },
      "Username (with or without @): deletes any new thread whose name is exactly that username. " +
        "User ID: deletes threads owned by that user, and also matches their cached username against thread names. " +
        "If you set a thread channel ID, only threads in that channel are checked. " +
        "You need the Manage Threads permission. Enable Developer Mode, then long-press a user and use Copy User ID."
    )
  );
}

const norm = (s) => String(s != null ? s : "").toLowerCase();
const clean = (s) => norm(s).replace(/[^a-z0-9À-￿]/g, "");
const isId = (s) => /^\d{15,25}$/.test(s);

const handled = new Set();

function getRest() {
  return metro.findByProps("get", "post", "del", "patch");
}

function toast(text) {
  try {
    toasts.showToast(text, assets.getAssetIDByName("Small"));
  } catch (e) {
    _vendetta.logger.log("[ThreadBlacklist] toast failed: " + String(e));
  }
}

function getEntries() {
  return String(plugin.storage.blacklist != null ? plugin.storage.blacklist : "")
    .split(/[,;\n]+/)
    .map((s) => s.trim().replace(/^@/, ""))
    .filter(Boolean);
}

// Returns a reason string when the thread belongs to a blacklisted user, otherwise null
function blacklistReason(ch) {
  const entries = getEntries();
  if (!entries.length) return null;

  const parentId = ch.parent_id != null ? ch.parent_id : ch.parentId;
  const ownerId = ch.owner_id != null ? ch.owner_id : ch.ownerId;
  const channelFilter = plugin.storage.threadChannelId;

  if (channelFilter && parentId !== channelFilter) return null;

  const ids = entries.filter(isId);
  if (ownerId && ids.indexOf(ownerId) !== -1) return "owner " + ownerId;

  // Thread name matched against the blacklisted @username (in the thread channel, or anywhere if none is set)
  const names = new Set(entries.filter((e) => !isId(e)).map(clean).filter((n) => n.length >= 2));
  try {
    const UserStore = metro.findByProps("getUser", "getCurrentUser");
    for (const id of ids) {
      const u = UserStore && UserStore.getUser ? UserStore.getUser(id) : null;
      if (u) {
        [u.username, u.globalName, u.global_name]
          .map(clean)
          .filter((n) => n.length >= 3)
          .forEach((n) => names.add(n));
      }
    }
  } catch (e) {
    _vendetta.logger.log("[ThreadBlacklist] user lookup failed: " + String(e));
  }

  const threadName = clean(ch.name);
  if (threadName && names.has(threadName)) return 'name "' + ch.name + '"';
  return null;
}

function isRecent(id) {
  try {
    const created = Number(BigInt(id) >> 22n) + 1420070400000;
    return Date.now() - created < 2 * 60 * 1000;
  } catch (e) {
    return true;
  }
}

async function removeThread(ch, reason) {
  const label = ch.name || ch.id;
  if (plugin.storage.dryRun) {
    _vendetta.logger.log("[ThreadBlacklist] TEST MODE: would delete " + ch.id + " (" + reason + ")");
    toast("Test mode: would delete thread " + label);
    return;
  }
  try {
    await getRest().del({ url: "/channels/" + ch.id });
    _vendetta.logger.log("[ThreadBlacklist] Deleted " + ch.id + " (" + reason + ")");
    toast("Deleted blacklisted thread " + label);
  } catch (e) {
    const status = e && (e.status != null ? e.status : e.response && e.response.status);
    _vendetta.logger.log("[ThreadBlacklist] Delete failed (" + status + "): " + String(e && (e.message || (e.body && e.body.message))));
    toast(status === 403 ? "Can't delete thread, missing Manage Threads permission" : "Failed to delete thread " + label);
  }
}

function onThreadCreate(ev) {
  try {
    const ch = ev && ev.channel;
    if (!ch || !ch.id) return;
    if (ev.isNewlyCreated === false) return;
    if (handled.has(ch.id)) return;
    if (!isRecent(ch.id)) return;

    const reason = blacklistReason(ch);
    if (!reason) return;

    handled.add(ch.id);
    removeThread(ch, reason);
  } catch (e) {
    _vendetta.logger.log("[ThreadBlacklist] handler error: " + String(e));
  }
}

const index = {
  onLoad() {
    if (plugin.storage.blacklist == null) plugin.storage.blacklist = "";
    if (plugin.storage.threadChannelId == null) plugin.storage.threadChannelId = "";
    if (plugin.storage.dryRun == null) plugin.storage.dryRun = false;
    common.FluxDispatcher.subscribe("THREAD_CREATE", onThreadCreate);
    _vendetta.logger.log("[ThreadBlacklist] Loaded.");
  },
  onUnload() {
    common.FluxDispatcher.unsubscribe("THREAD_CREATE", onThreadCreate);
    handled.clear();
    _vendetta.logger.log("[ThreadBlacklist] Unloaded.");
  },
  settings: Settings
};

exports.default = index;
return module.exports;
})();
