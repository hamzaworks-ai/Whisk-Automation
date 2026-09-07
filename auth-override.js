// Auth Override - Blocks Firebase and forces logged-in state

// Mock user object
const mockUser = {
  uid: "unlimited-user",
  email: "user@unlimited.com",
  displayName: "Unlimited User",
  photoURL: null,
  emailVerified: true,
  metadata: {
    creationTime: new Date().toISOString(),
    lastSignInTime: new Date().toISOString()
  }
};

const mockQuota = {
  status: "active",
  quotaRemaining: 100000,
  dailyLimit: 100000,
  dailyRemaining: 100000,
  dailyUsed: 0,
  used: 0,
  remaining: 100000,
  _xk1: true,
  _xq7: true
};

// Set initial storage
chrome.storage.local.set({
  authRequired: false,
  authState: {
    isLoggedIn: true,
    subscriptionStatus: "active",
    userId: mockUser.uid,
    email: mockUser.email,
    displayName: mockUser.displayName,
    lastUpdated: Date.now()
  },
  quotaStatus: mockQuota,
  user: mockUser
});

// Block Firebase completely
window.firebase = null;

// Override chrome.runtime.sendMessage to intercept auth requests
const originalSendMessage = chrome.runtime.sendMessage;
chrome.runtime.sendMessage = function(message, callback) {
  if (typeof message === 'object') {
    // Auth state requests
    if (message.action === 'getAuthState') {
      if (callback) {
        callback({
          isLoggedIn: true,
          subscriptionStatus: "active",
          userId: mockUser.uid,
          timestamp: Date.now()
        });
      }
      return true;
    }
    
    // Quota requests
    if (message.action === 'getQuotaStatus') {
      if (callback) {
        callback(mockQuota);
      }
      return true;
    }
    
    // Sign in requests
    if (message.action === 'signInWithGoogle') {
      if (callback) {
        callback({ success: true, token: "unlimited-access" });
      }
      return true;
    }
    
    // Update quota requests
    if (message.action === 'updateQuotaStatus' || message.action === 'updateProgress') {
      if (callback) {
        callback({ success: true });
      }
      return true;
    }
  }
  
  // Call original for everything else
  return originalSendMessage.call(this, message, callback);
};

// Intercept storage.local.get to return mocked auth
const originalGet = chrome.storage.local.get;
chrome.storage.local.get = function(keys, callback) {
  if (!keys || keys.includes('authState') || keys.includes('quotaStatus') || keys.includes('user')) {
    const result = {
      authState: {
        isLoggedIn: true,
        subscriptionStatus: "active",
        userId: mockUser.uid,
        email: mockUser.email,
        lastUpdated: Date.now()
      },
      quotaStatus: mockQuota,
      user: mockUser,
      authRequired: false
    };
    
    if (callback) {
      callback(result);
    }
    return Promise.resolve(result);
  }
  
  return originalGet.call(this, keys, callback);
};

// Block Google Identity
if (window.google) {
  window.google.accounts = null;
}

// Block any auth UI rendering
const observer = new MutationObserver((mutations) => {
  mutations.forEach((mutation) => {
    mutation.addedNodes.forEach((node) => {
      if (node.nodeType === 1) { // Element node
        // Remove any login/signup forms
        const loginForms = node.querySelectorAll ? node.querySelectorAll('[class*="login"], [class*="sign"], [class*="auth"]') : [];
        loginForms.forEach(form => {
          const text = form.textContent || '';
          if (text.includes('Sign in') || text.includes('Create Account') || text.includes('Continue with Google')) {
            form.style.display = 'none';
            console.log('Auth UI blocked:', form);
          }
        });
      }
    });
  });
});

// Start observing
observer.observe(document.body, { childList: true, subtree: true });

console.log('[Auth Override] Firebase blocked, auth forced to unlimited');
