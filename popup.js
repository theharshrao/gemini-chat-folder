
import { SupabaseClient } from './lib/supabase-client.js';
import { CONFIG } from './config.js';

// --- CONFIGURATION ---
const SUPABASE_URL = CONFIG.SUPABASE_URL;
const SUPABASE_KEY = CONFIG.SUPABASE_KEY;

const supabase = new SupabaseClient(SUPABASE_URL, SUPABASE_KEY);
const STORAGE_KEY = 'gemini_folders_data';
let isSyncing = false; // Prevent loops

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
const redirectInfo = document.getElementById('redirect-info'); // New element for debug

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

  if (session && session.refresh_token) {
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
    }
  }

  if (session && session.access_token) {
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
  const redirectUrl = chrome.identity.getRedirectURL();
  const authUrl = `${SUPABASE_URL}/auth/v1/authorize?provider=google&redirect_to=${encodeURIComponent(redirectUrl)}`;

  console.log("------------------------------------------------");
  console.log("Redirect URL:", redirectUrl);
  console.log("------------------------------------------------");
  
  // Show redirect URL in UI for easy debugging
  const infoDiv = document.getElementById('redirect-info');
  infoDiv.style.display = 'block';
  infoDiv.innerHTML = `<strong>REQUIRED:</strong> Add this to Supabase Redirect URLs:<br>
  <code style="user-select: all;">${redirectUrl}*</code>`;

  showStatus('Opening Google Login...', 'info');

  chrome.identity.launchWebAuthFlow({
    url: authUrl,
    interactive: true
  }, async (responseUrl) => {
    if (chrome.runtime.lastError || !responseUrl) {
      console.error(chrome.runtime.lastError);
      // If the user closed the window or the redirect failed
      showStatus('Login cancelled or failed. Check console for URL details.', 'error');
      return;
    }

    const hash = new URL(responseUrl).hash.substring(1);
    const params = new URLSearchParams(hash);
    const accessToken = params.get('access_token');
    const refreshToken = params.get('refresh_token');

    if (accessToken) {
      supabase.setSession(accessToken);

      try {
        const user = await supabase.getUser(accessToken);
        const session = {
          access_token: accessToken,
          refresh_token: refreshToken,
          user: user
        };
        await chrome.storage.local.set({ 'supabase_session': session });

        currentUser = user;
        showAppView();
        showStatus('Logged in with Google', 'success');
        syncData();
      } catch (err) {
        showStatus('Failed to fetch user details', 'error');
        console.error(err);
      }
    } else {
      showStatus('No access token received', 'error');
    }
  });
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
    const local = await chrome.storage.local.get(STORAGE_KEY);
    const localFolders = local[STORAGE_KEY]?.folders || [];

    const cloudRes = await supabase.getFolders(currentUser.id);
    let cloudFolders = [];
    if (cloudRes.length > 0) {
      cloudFolders = cloudRes[0].data.folders || [];
    }

    if (cloudFolders.length > 0) {
      await chrome.storage.local.set({ [STORAGE_KEY]: { folders: cloudFolders } });

      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs[0] && tabs[0].id) {
          chrome.tabs.sendMessage(tabs[0].id, { action: 'refreshFolders' }, (response) => {
            if (chrome.runtime.lastError) {
              console.log("Tab not ready for refresh:", chrome.runtime.lastError.message);
            }
          });
        }
      });
      showStatus('Synced from Cloud', 'success');
    } else if (localFolders.length > 0) {
      await supabase.upsertFolders(currentUser.id, { folders: localFolders });
      showStatus('Synced to Cloud', 'success');
    } else {
      showStatus('Sync complete (No data)', 'info');
    }

  } catch (err) {
    console.error("Sync Error Details:", err);
    showStatus('Sync failed: ' + (err.error?.message || err.message || 'Unknown'), 'error');
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
async function exportData() { /* ... existing export logic ... */ }
async function importData(event) { /* ... existing import logic ... */ }
