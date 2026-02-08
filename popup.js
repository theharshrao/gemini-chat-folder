
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
  if (stored.supabase_session && stored.supabase_session.access_token) {
    currentUser = stored.supabase_session.user;
    supabase.setSession(stored.supabase_session.access_token);
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
    const { data, error } = await supabase.signIn(email, password);
    if (error) throw error;

    // Save session
    const session = { access_token: data.access_token, user: data.user };
    await chrome.storage.local.set({ 'supabase_session': session });

    currentUser = data.user;
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
  // For extension, the best way without firebase is usually to open the Supabase Auth URL
  // and let the user copy the token, OR use chrome.identity.launchWebAuthFlow.
  // We will try a simpler approach for v1: Redirect to Supabase login page.

  const redirectUrl = chrome.identity.getRedirectURL();

  // Clean URL just in case (sometimes it adds trailing slash)
  const cleanRedirect = redirectUrl.endsWith('/') ? redirectUrl.slice(0, -1) : redirectUrl;

  const authUrl = `${SUPABASE_URL}/auth/v1/authorize?provider=google&redirect_to=${cleanRedirect}`;

  console.log("Launching Auth Flow:", authUrl);
  showStatus('Opening Google Login...', 'info');

  chrome.identity.launchWebAuthFlow({
    url: authUrl,
    interactive: true
  }, async (responseUrl) => {
    if (chrome.runtime.lastError || !responseUrl) {
      console.error(chrome.runtime.lastError);
      showStatus('Google Login failed: ' + (chrome.runtime.lastError?.message || 'Unknown'), 'error');
      return;
    }

    // Parse token from URL fragment
    // URL looks like: https://<id>.chromiumapp.org/#access_token=...&refresh_token=...
    const hash = new URL(responseUrl).hash.substring(1);
    const params = new URLSearchParams(hash);
    const accessToken = params.get('access_token');
    const refreshToken = params.get('refresh_token'); // Supabase sends this too often

    if (accessToken) {
      supabase.setSession(accessToken);

      try {
        // Fetch real user to get the ID
        const user = await supabase.getUser(accessToken);
        const session = { access_token: accessToken, user: user };
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
// ... (Keep existing logic or import it)
async function exportData() { /* ... existing export logic ... */ }
async function importData(event) { /* ... existing import logic ... */ }