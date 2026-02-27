import { SupabaseClient } from './lib/supabase-client.js';
import { CONFIG } from './config.js';

// --- CONFIGURATION ---
const SUPABASE_URL = CONFIG.SUPABASE_URL;
const SUPABASE_KEY = CONFIG.SUPABASE_KEY;

const supabase = new SupabaseClient(SUPABASE_URL, SUPABASE_KEY);
const STORAGE_KEY = 'gemini_folders_data';

// --- DOM ELEMENTS ---
const authView = document.getElementById('auth-view');
const appView = document.getElementById('app-view');
const emailInput = document.getElementById('email');
const passwordInput = document.getElementById('password');
const loginBtn = document.getElementById('login-btn');
const signupBtn = document.getElementById('signup-btn');
const googleBtn = document.getElementById('google-btn');
const logoutBtn = document.getElementById('logout-btn');
const statusDiv = document.getElementById('status');
const userDisplay = document.getElementById('user-display');

// --- STATE ---
let currentUser = null;

// --- INITIALIZATION ---
document.addEventListener('DOMContentLoaded', async () => {
  await checkSession();
  setupListeners();
});

async function checkSession() {
  // Check chrome.storage for saved session/token
  const stored = await chrome.storage.local.get(['supabase_session']);
  let session = stored.supabase_session;

  if (session && session.access_token && supabase.isTokenExpired(session.access_token) && session.refresh_token) {
    try {
      const data = await supabase.refreshToken(session.refresh_token);
      if (data && data.access_token) {
        console.log("Refreshed session token automatically");
        session = {
          access_token: data.access_token,
          refresh_token: data.refresh_token || session.refresh_token,
          user: data.user || session.user
        };
        await chrome.storage.local.set({ 'supabase_session': session });
      }
    } catch (e) {
      console.warn("Token refresh on startup failed", e);
      // Don't use the expired token if refresh fails
      session = null;
      await chrome.storage.local.remove('supabase_session');
    }
  }

  if (session && session.access_token && !supabase.isTokenExpired(session.access_token)) {
    currentUser = session.user;
    supabase.setSession(session.access_token);
    showAppView();
    syncData(); // Trigger sync on load
  } else {
    showAuthView();
  }
}

function setupListeners() {
  loginBtn.addEventListener('click', handleLogin);
  signupBtn.addEventListener('click', handleSignup);
  googleBtn.addEventListener('click', handleGoogleLogin);
  logoutBtn.addEventListener('click', handleLogout);
  document.getElementById('guest-btn').addEventListener('click', () => {
    showAppView();
    showStatus('Running in Local Mode', 'info');
  });

  // App buttons
  document.getElementById('export-btn').addEventListener('click', exportData);
  document.getElementById('import-btn').addEventListener('click', () => document.getElementById('file-input').click());
  document.getElementById('file-input').addEventListener('change', importData);
}

// --- AUTH HANDLERS ---
async function handleLogin() {
  const email = emailInput.value;
  const password = passwordInput.value;
  if (!email || !password) return showStatus('Please enter email and password', 'error');

  showStatus('Logging in...', 'info');
  try {
    const response = await supabase.signIn(email, password);
    // response is the session object directly

    // Save session
    const session = {
      access_token: response.access_token,
      refresh_token: response.refresh_token,
      user: response.user
    };
    await chrome.storage.local.set({ 'supabase_session': session });

    currentUser = response.user;
    showAppView();
    showStatus('Logged in successfully', 'success');
    syncData();
  } catch (err) {
    showStatus(err.error?.msg || err.message || 'Login failed', 'error');
  }
}

async function handleSignup() {
  const email = emailInput.value;
  const password = passwordInput.value;
  if (!email || !password) return showStatus('Please enter email and password', 'error');

  showStatus('Signing up...', 'info');
  try {
    const { data, error } = await supabase.signUp(email, password);
    if (error) throw error;

    showStatus('Check your email to confirm signup!', 'success');
  } catch (err) {
    showStatus(err.error?.msg || err.message || 'Signup failed', 'error');
  }
}

async function handleGoogleLogin() {
  const redirectUrl = 'https://gemini.google.com';
  const authUrl = `${SUPABASE_URL}/auth/v1/authorize?provider=google&redirect_to=${encodeURIComponent(redirectUrl)}`;

  showStatus('Opening Google Login...', 'info');
  chrome.tabs.create({ url: authUrl });

  // Close the popup so the user focuses on the new tab
  window.close();
}

function handleLogout() {
  chrome.storage.local.remove('supabase_session');
  currentUser = null;
  supabase.setSession(null);
  showAuthView();
}

// --- SYNC LOGIC ---
async function syncData() {
  if (!currentUser) return;
  showStatus('Syncing...', 'info');

  try {
    // 1. Load Local
    const local = await chrome.storage.local.get(STORAGE_KEY);
    const localFolders = local[STORAGE_KEY]?.folders || [];

    // 2. Load Cloud
    const cloudRes = await supabase.getFolders(currentUser.id);
    // cloudRes is array of rows. We expect 0 or 1 row.
    let cloudFolders = [];
    if (cloudRes.length > 0) {
      cloudFolders = cloudRes[0].data.folders || [];
    }

    // 3. Merge (Simple Strategy: Cloud wins if exists, else Local pushes)
    // For a seamless experience, if Cloud is empty and Local has data -> Push Local
    // If Cloud has data -> Pull Cloud (overwrite local) - *User should know this*

    if (cloudFolders.length > 0) {
      // Pull from Cloud
      await chrome.storage.local.set({ [STORAGE_KEY]: { folders: cloudFolders } });

      // Notify Sync to Tabs
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs[0] && tabs[0].id) {
          chrome.tabs.sendMessage(tabs[0].id, { action: 'refreshFolders' }, (response) => {
            if (chrome.runtime.lastError) {
              // Ignore error if content script not ready
              console.log("Tab not ready for refresh:", chrome.runtime.lastError.message);
            }
          });
        }
      });
      showStatus('Synced from Cloud', 'success');
    } else if (localFolders.length > 0) {
      // Push to Cloud
      await supabase.upsertFolders(currentUser.id, { folders: localFolders });
      showStatus('Synced to Cloud', 'success');
    } else {
      showStatus('Sync complete (No data)', 'info');
    }

  } catch (err) {
    console.error("Sync Error Details:", err);
    if (err.status === 401) {
      chrome.storage.local.remove('supabase_session');
      currentUser = null;
      supabase.setSession(null);
      showAuthView();
      showStatus('Session expired. Please log in again.', 'error');
    } else {
      showStatus('Sync failed: ' + (err.error?.message || err.message || 'Unknown'), 'error');
    }
  }
}

// --- UI HELPERS ---
function showAuthView() {
  authView.classList.remove('hidden');
  appView.classList.add('hidden');
}

function showAppView() {
  authView.classList.add('hidden');
  appView.classList.remove('hidden');
  if (currentUser) {
    userDisplay.textContent = `Logged in as: ${currentUser.email || 'User'}`;
  }
}

function showStatus(msg, type = 'info') {
  statusDiv.textContent = msg;
  statusDiv.style.color = type === 'error' ? '#d93025' : '#1a73e8';
  setTimeout(() => statusDiv.textContent = '', 4000);
}

// --- EXISTING EXPORT/IMPORT ---
// ... (Keep existing logic or import it)
async function exportData() { /* ... existing export logic ... */ }
async function importData(event) { /* ... existing import logic ... */ }