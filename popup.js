document.addEventListener('DOMContentLoaded', function() {
  // UI Elements
  const themeToggle = document.getElementById('themeToggle');
  const includeCode = document.getElementById('includeCode');
  const includeMarkdown = document.getElementById('includeMarkdown');
  const skipEmpty = document.getElementById('skipEmpty');
  const promptTemplate = document.getElementById('promptTemplate');
  const customTemplate = document.getElementById('customTemplate');
  const selectionMode = document.getElementById('selectionMode');
  const refreshCells = document.getElementById('refreshCells');
  const cellList = document.getElementById('cellList');
  const copyBtn = document.getElementById('copyBtn');
  const downloadBtn = document.getElementById('downloadBtn');
  const statusDiv = document.getElementById('status');
  
  // State variables
  let currentTheme = localStorage.getItem('jupyterExtTheme') || 'light';
  let notebookCells = [];
  let extractedContent = '';
  
  // Template definitions
  const TEMPLATES = {
    'none': '{{content}}',
    'explain': 'Please explain the following Jupyter notebook code and analysis in detail:\n\n{{content}}',
    'summary': 'Please provide a concise summary of the following Jupyter notebook analysis:\n\n{{content}}',
    'debug': 'Debug the following Jupyter notebook code and explain any issues or improvements:\n\n{{content}}',
    'improve': 'Review the following Jupyter notebook code and suggest specific improvements for efficiency, readability, and best practices:\n\n{{content}}'
  };
  
  // Initialize UI state
  function initializeUI() {
    // Set theme
    document.documentElement.setAttribute('data-theme', currentTheme);
    themeToggle.textContent = currentTheme === 'light' ? 'Dark' : 'Light';
    
    // Setup accordion behavior
    setupAccordions();
    
    // Setup prompt template behavior
    promptTemplate.addEventListener('change', handleTemplateChange);
    
    // Init selection mode
    selectionMode.addEventListener('change', toggleSelectionMode);
    refreshCells.addEventListener('click', loadCellList);
  }
  
  // Setup accordions
  function setupAccordions() {
    document.querySelectorAll('.accordion-header').forEach(header => {
      header.addEventListener('click', () => {
        const accordion = header.parentElement;
        const toggleElement = header.querySelector('.accordion-toggle');
        
        // Toggle accordion state
        accordion.classList.toggle('open');
        
        // Update toggle text
        if (accordion.classList.contains('open')) {
          toggleElement.textContent = 'Hide';
        } else {
          toggleElement.textContent = 'Show';
        }
      });
    });
    
    // Set initial toggle states
    document.querySelectorAll('.accordion').forEach(accordion => {
      const toggleElement = accordion.querySelector('.accordion-toggle');
      if (accordion.classList.contains('open')) {
        toggleElement.textContent = 'Hide';
      } else {
        toggleElement.textContent = 'Show';
      }
    });
  }
  
  // Toggle dark/light theme
  themeToggle.addEventListener('click', () => {
    currentTheme = currentTheme === 'light' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', currentTheme);
    themeToggle.textContent = currentTheme === 'light' ? 'Dark' : 'Light';
    localStorage.setItem('jupyterExtTheme', currentTheme);
  });
  
  // Handle template selection
  function handleTemplateChange() {
    if (promptTemplate.value === 'custom') {
      customTemplate.style.display = 'block';
      if (!customTemplate.value) {
        customTemplate.value = 'Please analyze the following notebook:\n\n{{content}}';
      }
    } else {
      customTemplate.style.display = 'none';
    }
  }
  
  // Toggle cell selection mode
  function toggleSelectionMode() {
    if (selectionMode.checked) {
      cellList.style.display = 'block';
      loadCellList();
    } else {
      cellList.style.display = 'none';
    }
  }
  
  // Load cell list from page
  function loadCellList() {
    setStatus('Loading cells...', '');
    cellList.innerHTML = '<div class="cell-item"><span class="cell-preview">Loading cells...</span></div>';
    
    chrome.tabs.query({active: true, currentWindow: true}, function(tabs) {
      if (!tabs[0]) {
        setStatus('No active tab found', 'error');
        return;
      }
      
      chrome.tabs.sendMessage(
        tabs[0].id,
        {action: 'getCellList'},
        function(response) {
          if (chrome.runtime.lastError || !response || !response.success) {
            // Try injecting content script first
            chrome.scripting.executeScript({
              target: {tabId: tabs[0].id},
              files: ['content.js']
            }, () => {
              setTimeout(() => {
                chrome.tabs.sendMessage(
                  tabs[0].id,
                  {action: 'getCellList'},
                  handleCellListResponse
                );
              }, 200);
            });
          } else {
            handleCellListResponse(response);
          }
        }
      );
    });
  }
  
  // Handle cell list response
  function handleCellListResponse(response) {
    if (!response || !response.success) {
      cellList.innerHTML = '<div class="cell-item"><span class="cell-preview">No cells found</span></div>';
      setStatus('No cells found or not a notebook page', 'warning');
      return;
    }
    
    notebookCells = response.cells;
    
    if (notebookCells.length === 0) {
      cellList.innerHTML = '<div class="cell-item"><span class="cell-preview">No cells found</span></div>';
      return;
    }
    
    cellList.innerHTML = '';
    notebookCells.forEach((cell, index) => {
      const preview = truncateText(cell.source.trim(), 40) || '(Empty cell)';
      const isEmpty = cell.source.trim() === '';
      
      const cellElement = document.createElement('div');
      cellElement.className = 'cell-item';
      cellElement.innerHTML = `
        <input type="checkbox" id="cell-${index}" data-index="${index}" ${isEmpty ? '' : 'checked'}>
        <span class="cell-type ${cell.cell_type}">${cell.cell_type}</span>
        <span class="cell-preview">${preview}</span>
      `;
      cellList.appendChild(cellElement);
    });
    
    setStatus('Cells loaded successfully', 'success');
    setTimeout(() => {
      setStatus('Ready to extract content', '');
    }, 1500);
  }
  
  // Truncate text for preview
  function truncateText(text, length) {
    return text.length > length ? text.substring(0, length) + '...' : text;
  }
  
  // Set status message
  function setStatus(message, type) {
    statusDiv.textContent = message;
    statusDiv.className = 'status ' + (type || '');
  }
  
  // Get selected template
  function getSelectedTemplate() {
    const templateKey = promptTemplate.value;
    if (templateKey === 'custom') {
      return customTemplate.value || '{{content}}';
    } else {
      return TEMPLATES[templateKey] || '{{content}}';
    }
  }
  
  // Apply template to content
  function applyTemplate(content) {
    const template = getSelectedTemplate();
    return template.replace('{{content}}', content);
  }
  
  // Get extraction options
  function getExtractionOptions() {
    const selectedCells = [];
    
    if (selectionMode.checked) {
      // Get selected cells from UI
      document.querySelectorAll('#cellList input[type="checkbox"]:checked').forEach(checkbox => {
        const index = parseInt(checkbox.dataset.index);
        if (!isNaN(index) && index >= 0 && index < notebookCells.length) {
          selectedCells.push(index);
        }
      });
    }
    
    return {
      includeCode: includeCode.checked,
      includeMarkdown: includeMarkdown.checked,
      skipEmpty: skipEmpty.checked,
      selectedCells: selectedCells,
      selectionMode: selectionMode.checked
    };
  }
  
  // Extract content with options
  function extractContent(action) {
    // Set loading state
    const btn = action === 'copy' ? copyBtn : downloadBtn;
    btn.classList.add('loading');
    btn.disabled = true;
    setStatus('Extracting notebook content...', '');
    
    const options = getExtractionOptions();
    
    // Try injecting the content script and extracting content
    chrome.tabs.query({active: true, currentWindow: true}, function(tabs) {
      if (!tabs[0]) {
        setStatus('No active tab found', 'error');
        resetButtonState();
        return;
      }
      
      // Check if we can inject a content script
      chrome.scripting.executeScript({
        target: {tabId: tabs[0].id},
        files: ['content.js'] 
      }, (injectionResults) => {
        if (chrome.runtime.lastError) {
          setStatus('Cannot access this page: ' + chrome.runtime.lastError.message, 'error');
          resetButtonState();
          return;
        }
        
        // Send the extraction message
        setTimeout(() => {
          chrome.tabs.sendMessage(
            tabs[0].id,
            {
              action: 'extractNotebookText',
              outputAction: action,
              options: options
            },
            function(response) {
              resetButtonState();
              
              if (chrome.runtime.lastError) {
                setStatus('Error: ' + chrome.runtime.lastError.message, 'error');
                return;
              }
              
              if (response && response.success) {
                if (action === 'copy' && response.text) {
                  // Store the extracted content
                  extractedContent = response.text;
                  
                  // Apply template
                  const finalContent = applyTemplate(extractedContent);
                  
                  // Copy to clipboard
                  copyToClipboard(finalContent);
                } else if (action === 'download') {
                  setStatus('Content downloaded successfully!', 'success');
                }
              } else if (response && response.error) {
                setStatus('Error: ' + response.error, 'error');
              } else {
                setStatus('No notebook content found on this page', 'error');
              }
            }
          );
        }, 200); // Small delay to ensure content script is loaded
      });
    });
  }
  
  // Reset button loading state
  function resetButtonState() {
    copyBtn.classList.remove('loading');
    downloadBtn.classList.remove('loading');
    copyBtn.disabled = false;
    downloadBtn.disabled = false;
  }
  
  // Copy to clipboard
  function copyToClipboard(text) {
    navigator.clipboard.writeText(text)
      .then(() => {
        setStatus('Copied to clipboard!', 'success');
      })
      .catch(err => {
        console.error('Could not copy text: ', err);
        setStatus('Failed to copy to clipboard', 'error');
      });
  }
  
  // Copy button click handler
  copyBtn.addEventListener('click', function() {
    extractContent('copy');
  });
  
  // Download button click handler
  downloadBtn.addEventListener('click', function() {
    extractContent('download');
  });
  
  // Initialize the UI
  initializeUI();
});