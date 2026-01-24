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
    savedMessage: "✓ Settings saved"
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
    savedMessage: "✓ Configuración guardada"
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

  // Save preference
  chrome.storage.local.set({ language: lang });
}

// Initialize
document.addEventListener('DOMContentLoaded', () => {
  // Load saved permission mode
  chrome.storage.local.get(['permissionMode', 'language'], (result) => {
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
  });

  // Language Selector Listener
  const langSelector = document.getElementById('languageSelect');
  if (langSelector) {
    langSelector.addEventListener('change', (e) => {
      setLanguage(e.target.value);
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