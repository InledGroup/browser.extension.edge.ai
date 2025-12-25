// Popup script - Controls for the extension

// Load saved permission mode
chrome.storage.local.get(['permissionMode'], (result) => {
  const mode = result.permissionMode || 'ask';
  document.querySelector(`input[value="${mode}"]`).checked = true;
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
