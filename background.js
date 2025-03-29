const recentDownloads = new Map();

// Listen for installation events
chrome.runtime.onInstalled.addListener(function(details) {
  console.log('Jupyter Notebook to LLM Extractor installed');
});

// Listen for messages from content script or popup
// Listen for messages from content script or popup
chrome.runtime.onMessage.addListener(function(request, sender, sendResponse) {
  console.log("Background script received message:", request.action);
  
  if (request.action === 'downloadText') {
    downloadText(request.text, request.filename, request.source || 'unknown');
    sendResponse({success: true});
  }
  else if (request.action === 'initiateExtraction') {
    // Popup is asking to start the extraction process
    // Get the active tab and inject the content script if needed
    chrome.tabs.query({active: true, currentWindow: true}, async function(tabs) {
      if (tabs.length === 0) {
        sendResponse({success: false, error: 'No active tab found'});
        return;
      }
      
      try {
        // Try to inject the content script
        await chrome.scripting.executeScript({
          target: {tabId: tabs[0].id},
          files: ['content.js']
        });
        
        // Now send a message to the content script
        chrome.tabs.sendMessage(
          tabs[0].id,
          {
            action: 'extractNotebookText',
            outputAction: request.outputAction,
            options: request.options
          },
          function(response) {
            console.log("Response from content script:", response);
            // We don't need to do anything here, as the content script
            // will communicate back to the background script to download
          }
        );
        
        sendResponse({success: true});
      } catch (error) {
        console.error("Error injecting script:", error);
        sendResponse({success: false, error: error.message});
      }
    });
    
    return true; // Required for async sendResponse
  }
  
  return true; // Required for async sendResponse
});

/**
 * Trigger a download of the extracted text
 */
function downloadText(text, filename, source = '') {
  if (!text || !filename) {
    console.error('Invalid download parameters');
    return;
  }
  
  // Prevent duplicate downloads
  const now = Date.now();
  const downloadKey = `${filename}_${text.length}`;
  
  // If we've downloaded this exact file in the last 2 seconds, skip it
  if (recentDownloads.has(downloadKey)) {
    const lastTime = recentDownloads.get(downloadKey);
    if (now - lastTime < 2000) { // 2 second deduplication window
      console.log(`Skipping duplicate download for ${filename} (${source})`);
      return;
    }
  }
  
  // Track this download
  recentDownloads.set(downloadKey, now);
  
  // Cleanup old entries (anything older than 10 seconds)
  for (const [key, timestamp] of recentDownloads.entries()) {
    if (now - timestamp > 10000) {
      recentDownloads.delete(key);
    }
  }
  
  console.log(`Downloading ${filename} from ${source}`);
  
  // For Manifest V3 service workers, we need to use a different approach
  // as Blob URLs don't work directly in service workers
  
  // Method 1: Use chrome.downloads.download with Data URI
  try {
    const dataUrl = 'data:text/plain;charset=utf-8,' + encodeURIComponent(text);
    
    chrome.downloads.download({
      url: dataUrl,
      filename: filename,
      saveAs: false // Change to true if you want the user to choose location
    }, function(downloadId) {
      if (chrome.runtime.lastError) {
        console.error('Download failed:', chrome.runtime.lastError);
        
        // If data URI is too large, fall back to method 2
        if (dataUrl.length > 2000000) { // ~2MB limit for data URIs
          downloadWithTemporaryDocument(text, filename);
        }
      }
    });
  } catch (error) {
    console.error("Error in downloadText:", error);
    // Fallback method
    downloadWithTemporaryDocument(text, filename);
  }
}

/**
 * Alternative download method using a temporary document
 */
function downloadWithTemporaryDocument(text, filename) {
  // Create a temporary HTML file with the text content
  const htmlContent = `
    <!DOCTYPE html>
    <html>
    <head>
      <title>${filename}</title>
      <script>
        // Download the text automatically when page loads
        window.onload = function() {
          const blob = new Blob([${JSON.stringify(text)}], {type: 'text/plain'});
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = "${filename}";
          a.click();
          setTimeout(() => {
            URL.revokeObjectURL(url);
            window.close();
          }, 1000);
        };
      </script>
    </head>
    <body>
      <p>Downloading your file... This window will close automatically.</p>
      <p>If the download doesn't start automatically, <a id="download-link" href="#">click here</a>.</p>
      <script>
        document.getElementById('download-link').onclick = function(e) {
          e.preventDefault();
          const blob = new Blob([${JSON.stringify(text)}], {type: 'text/plain'});
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = "${filename}";
          a.click();
          URL.revokeObjectURL(url);
        };
      </script>
    </body>
    </html>
  `;
  
  // Create a new tab with this HTML content
  chrome.tabs.create({
    url: 'data:text/html;charset=utf-8,' + encodeURIComponent(htmlContent),
    active: false
  }, function(tab) {
    // Tab will auto-close after download
    // Add a backup timeout to close the tab after 5 seconds if something goes wrong
    setTimeout(() => {
      try {
        chrome.tabs.remove(tab.id);
      } catch (e) {
        // Tab might already be closed
      }
    }, 5000);
  });
}