// Popup script - Controls for the extension

const translations = {
  en: {
    subtitle: "Browser Extension",
    statusTitle: "Status",
    statusActive: "Extension active",
    permissionsTitle: "Permission Mode",
    askModeTitle: "🤔 Ask (Recommended)",
    askModeDesc: "Confirmation will be requested before each web search",
    permissiveModeTitle: "✅ Permissive",
    permissiveModeDesc: "Allows all searches automatically without asking",
    savedMessage: "✓ Settings saved",
    updatesTitle: "Updates",
    checkUpdatesBtn: "Check for updates",
    checkingUpdates: "Checking...",
    noUpdates: "No updates available",
    updateFound: "Update found!",
    updateError: "Failed to check",
    updateAvailableText: "New patch detected:",
    downloadPatch: "Download Patch"
  },
  es: {
    subtitle: "Extensión de Navegador",
    statusTitle: "Estado",
    statusActive: "Extensión activa",
    permissionsTitle: "Modo de Permisos",
    askModeTitle: "🤔 Preguntar (Recomendado)",
    askModeDesc: "Se pedirá confirmación antes de cada búsqueda web",
    permissiveModeTitle: "✅ Permisivo",
    permissiveModeDesc: "Permite todas las búsquedas automáticamente sin preguntar",
    savedMessage: "✓ Configuración guardada",
    updatesTitle: "Actualizaciones",
    checkUpdatesBtn: "Buscar actualizaciones",
    checkingUpdates: "Buscando...",
    noUpdates: "No hay actualizaciones",
    updateFound: "¡Actualización encontrada!",
    updateError: "Error al buscar",
    updateAvailableText: "Nuevo parche detectado:",
    downloadPatch: "Descargar Parche"
  }
};

function setLanguage(lang) {
  // Fallback to English if lang is not supported
  if (!translations[lang]) lang = 'en';

  // Update UI text
  document.querySelectorAll('[data-i18n]').forEach(element => {
    const key = element.getAttribute('data-i18n');
    if (translations[lang][key]) {
      element.textContent = translations[lang][key];
    }
  });

  // Update selector value
  const selector = document.getElementById('languageSelect');
  if (selector) selector.value = lang;

  // Update download button text if visible
  chrome.storage.local.get(['pendingUpdate'], (result) => {
    if (result.pendingUpdate) {
      const btn = document.getElementById('downloadUpdateBtn');
      if (btn) {
        btn.textContent = `${translations[lang].downloadPatch} (${result.pendingUpdate.id})`;
      }
    }
  });

  // Save preference
  chrome.storage.local.set({ language: lang });
}

// Helper to show download button
function showDownloadButton(updateData) {
  const container = document.getElementById('downloadContainer');
  const btn = document.getElementById('downloadUpdateBtn');
  
  if (container && btn) {
    const lang = document.getElementById('languageSelect').value || 'es';
    const label = translations[lang].downloadPatch;
    btn.textContent = `${label} (${updateData.id})`;
    container.style.display = 'block';
    
    btn.onclick = () => {
      chrome.tabs.create({ url: updateData.url });
    };
  }
}

// Initialize
document.addEventListener('DOMContentLoaded', () => {
  // Load saved permission mode
  chrome.storage.local.get(['permissionMode', 'language', 'pendingUpdate'], (result) => {
    // Permission Mode
    const mode = result.permissionMode || 'ask';
    const radio = document.querySelector(`input[value="${mode}"]`);
    if (radio) radio.checked = true;

    // Language
    let lang = result.language;
    if (!lang) {
      // Auto-detect
      const browserLang = navigator.language.split('-')[0]; // 'en-US' -> 'en'
      lang = (browserLang === 'es') ? 'es' : 'en';
    }
    setLanguage(lang);

    // Check if there's already a pending update found by background
    if (result.pendingUpdate) {
      showDownloadButton(result.pendingUpdate);
    }
  });

  // Language Selector Listener
  const langSelector = document.getElementById('languageSelect');
  if (langSelector) {
    langSelector.addEventListener('change', (e) => {
      setLanguage(e.target.value);
    });
  }

  // Update Check Listener
  const checkBtn = document.getElementById('checkUpdatesBtn');
  const statusEl = document.getElementById('updateStatus');
  
  if (checkBtn) {
    checkBtn.addEventListener('click', async () => {
      const currentLang = document.getElementById('languageSelect').value;
      checkBtn.disabled = true;
      statusEl.textContent = translations[currentLang].checkingUpdates;
      statusEl.className = 'update-status';
      document.getElementById('downloadContainer').style.display = 'none';

      try {
        const response = await chrome.runtime.sendMessage({ type: 'CHECK_UPDATES_MANUAL' });
        
        if (response && response.updateFound) {
          statusEl.textContent = translations[currentLang].updateFound;
          statusEl.className = 'update-status found';
          
          // Fetch the saved update data to show the button
          const data = await chrome.storage.local.get(['pendingUpdate']);
          if (data.pendingUpdate) {
            showDownloadButton(data.pendingUpdate);
          }
        } else {
          statusEl.textContent = translations[currentLang].noUpdates;
        }
      } catch (err) {
        statusEl.textContent = translations[currentLang].updateError;
      } finally {
        setTimeout(() => {
          checkBtn.disabled = false;
        }, 1000);
      }
    });
  }
});

// Listen for permission mode changes
document.querySelectorAll('input[name="permissionMode"]').forEach(radio => {
  radio.addEventListener('change', (e) => {
    const mode = e.target.value;
    
    // Save to storage
    chrome.storage.local.set({ permissionMode: mode }, () => {
      console.log('[Popup] Permission mode saved:', mode);
      
      // Show saved message
      const savedMessage = document.getElementById('savedMessage');
      savedMessage.classList.add('show');
      
      setTimeout(() => {
        savedMessage.classList.remove('show');
      }, 2000);

      // Notify all content scripts
      chrome.tabs.query({}, (tabs) => {
        tabs.forEach(tab => {
          chrome.tabs.sendMessage(tab.id, {
            type: 'PERMISSION_MODE_CHANGED',
            mode
          }).catch(() => {
            // Ignore errors for tabs without content script
          });
        });
      });
    });
  });
});