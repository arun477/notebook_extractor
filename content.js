// Listen for messages from the popup
chrome.runtime.onMessage.addListener(function(request, sender, sendResponse) {
  if (request.action === 'extractNotebookText') {
    console.log("Extracting notebook content with options:", request.options);
    extractNotebookContent(request.outputAction || 'download', request.options || {})
      .then(result => {
        sendResponse(result);
      }).catch(error => {
        sendResponse({success: false, error: error.message});
      });
    return true; // Required for async sendResponse
  } else if (request.action === 'getCellList') {
    console.log("Getting cell list");
    getCellList()
      .then(result => {
        sendResponse(result);
      }).catch(error => {
        sendResponse({success: false, error: error.message});
      });
    return true; // Required for async sendResponse
  } else if (request.action === 'chunkContent') {
    console.log("Chunking content for", request.modelName);
    const chunks = chunkContent(request.content, request.tokenPerChunk);
    createChunkedDownloads(chunks, request.modelName);
    sendResponse({success: true, chunks: chunks.length});
    return true;
  }
});

/**
 * Main function to extract notebook content with options
 * @param {string} outputAction - What to do with the content ('download' or 'copy')
 * @param {Object} options - Extraction options
 */
async function extractNotebookContent(outputAction = 'download', options = {}) {
  try {
    console.log("Starting extraction process with options:", options);
    
    // Try all possible extraction methods
    let notebook = await tryExtractNotebook();
    
    if (!notebook || !notebook.cells || notebook.cells.length === 0) {
      return {success: false, error: 'No notebook content found on this page'};
    }
    
    // Extract cell content based on options
    const { text, tokenCount } = extractCellsWithOptions(notebook, options);
    console.log(`Extracted ${text.length} characters, ~${tokenCount} tokens`);
    
    // Handle the content based on the requested action
    if (outputAction === 'copy') {
      // For copy action, return the text to the popup for clipboard copying
      return {success: true, text: text, tokenCount: tokenCount};
    } else {
      // For download action, request the background script to download
      chrome.runtime.sendMessage({
        action: 'downloadText',
        text: text,
        filename: getFilename()
      });
      
      return {success: true, tokenCount: tokenCount};
    }
  } catch (error) {
    console.error('Extraction error:', error);
    return {success: false, error: error.message};
  }
}

/**
 * Get list of cells from the notebook
 */
async function getCellList() {
  try {
    // Try all possible extraction methods
    let notebook = await tryExtractNotebook();
    
    if (!notebook || !notebook.cells || notebook.cells.length === 0) {
      return {success: false, error: 'No notebook content found on this page'};
    }
    
    // Return simplified cell info
    const cells = notebook.cells.map(cell => ({
      cell_type: cell.cell_type,
      source: processSource(cell.source),
      isEmpty: processSource(cell.source).trim() === ''
    }));
    
    return {success: true, cells: cells};
  } catch (error) {
    console.error('Error getting cell list:', error);
    return {success: false, error: error.message};
  }
}

/**
 * Try all possible methods to extract notebook content
 */
async function tryExtractNotebook() {
  // Method 1: Try to find raw JSON data
  try {
    const preElement = document.querySelector('pre');
    if (preElement) {
      const content = preElement.textContent.trim();
      if (content.startsWith('{') && content.includes('"cells"')) {
        try {
          const parsed = JSON.parse(content);
          if (parsed.cells && Array.isArray(parsed.cells)) {
            console.log("Found notebook JSON in pre element");
            return parsed;
          }
        } catch (e) {
          console.log("Not valid JSON in pre element");
        }
      }
    }
  } catch (e) {
    console.error("Error checking pre elements:", e);
  }
  
  // Method 2: Extract from visible cells on page
  try {
    // For JupyterLab
    const cells = [];
    
    // Check for JupyterLab cells
    const jupyterLabMarkdownCells = document.querySelectorAll('.jp-MarkdownCell');
    const jupyterLabCodeCells = document.querySelectorAll('.jp-CodeCell');
    
    if (jupyterLabMarkdownCells.length > 0 || jupyterLabCodeCells.length > 0) {
      console.log(`Found JupyterLab cells: ${jupyterLabMarkdownCells.length} markdown, ${jupyterLabCodeCells.length} code`);
      
      // Process markdown cells
      jupyterLabMarkdownCells.forEach(cell => {
        const content = cell.querySelector('.jp-RenderedMarkdown');
        if (content) {
          cells.push({
            cell_type: 'markdown',
            source: content.innerText || content.textContent
          });
        }
      });
      
      // Process code cells
      jupyterLabCodeCells.forEach(cell => {
        const codeContent = cell.querySelector('.jp-InputArea-editor');
        if (codeContent) {
          cells.push({
            cell_type: 'code',
            source: codeContent.innerText || codeContent.textContent
          });
        }
      });
      
      if (cells.length > 0) {
        return { cells: cells };
      }
    }
    
    // Check for Classic Notebook cells
    const classicMarkdownCells = document.querySelectorAll('.text_cell');
    const classicCodeCells = document.querySelectorAll('.code_cell');
    
    if (classicMarkdownCells.length > 0 || classicCodeCells.length > 0) {
      console.log(`Found Classic Notebook cells: ${classicMarkdownCells.length} markdown, ${classicCodeCells.length} code`);
      
      // Process markdown cells
      classicMarkdownCells.forEach(cell => {
        const content = cell.querySelector('.text_cell_render');
        if (content) {
          cells.push({
            cell_type: 'markdown',
            source: content.innerText || content.textContent
          });
        }
      });
      
      // Process code cells (get only input, not output)
      classicCodeCells.forEach(cell => {
        const codeContent = cell.querySelector('.input_area');
        if (codeContent) {
          cells.push({
            cell_type: 'code',
            source: codeContent.innerText || codeContent.textContent
          });
        }
      });
      
      if (cells.length > 0) {
        return { cells: cells };
      }
    }
    
    // Check for Google Colab cells
    const colabCells = document.querySelectorAll('.cell');
    
    if (colabCells.length > 0) {
      colabCells.forEach(cell => {
        // Check for text cells
        const textCell = cell.querySelector('.text_cell_render');
        if (textCell) {
          cells.push({
            cell_type: 'markdown',
            source: textCell.innerText || textCell.textContent
          });
          return;
        }
        
        // Check for code cells
        const codeCell = cell.querySelector('.input');
        if (codeCell) {
          const codeBlock = codeCell.querySelector('pre') || codeCell.querySelector('.CodeMirror-code');
          if (codeBlock) {
            cells.push({
              cell_type: 'code',
              source: codeBlock.innerText || codeBlock.textContent
            });
          }
        }
      });
      
      if (cells.length > 0) {
        return { cells: cells };
      }
    }
    
    // Method 3: Generic attempt to find code and text blocks
    const allPreElements = document.querySelectorAll('pre');
    const allMarkdownElements = document.querySelectorAll('div[class*="markdown"], div[class*="text_cell"]');
    
    if (allPreElements.length > 0 || allMarkdownElements.length > 0) {
      console.log(`Found generic elements: ${allMarkdownElements.length} markdown-like, ${allPreElements.length} code-like`);
      
      // Process markdown-like elements
      allMarkdownElements.forEach(el => {
        cells.push({
          cell_type: 'markdown',
          source: el.innerText || el.textContent
        });
      });
      
      // Process code-like elements
      allPreElements.forEach(el => {
        // Skip if it's likely JSON (already tried to parse that)
        const content = el.innerText || el.textContent;
        if (!content.trim().startsWith('{') || !content.includes('"cells"')) {
          cells.push({
            cell_type: 'code',
            source: content
          });
        }
      });
      
      if (cells.length > 0) {
        return { cells: cells };
      }
    }
  } catch (e) {
    console.error("Error extracting from visible cells:", e);
  }
  
  console.log("No notebook content found");
  return null;
}

/**
 * Check if a cell is empty
 */
function isCellEmpty(cell) {
  if (!cell || !cell.source) return true;
  
  const source = processSource(cell.source);
  
  // Check if the cell content is just whitespace
  return source.trim() === '';
}

/**
 * Extract cells based on provided options
 */
function extractCellsWithOptions(notebook, options) {
  let content = '';
  const defaultOptions = {
    includeCode: true,
    includeMarkdown: true,
    skipEmpty: true,
    selectedCells: [],
    selectionMode: false
  };
  
  // Merge defaults with provided options
  const opts = {...defaultOptions, ...options};
  
  // Add title if available
  if (notebook.metadata && notebook.metadata.title) {
    content += `# ${notebook.metadata.title}\n\n`;
  }
  
  // Filter cells based on options
  let filteredCells = notebook.cells.filter(cell => {
    // Skip empty cells if option is enabled
    if (opts.skipEmpty && isCellEmpty(cell)) {
      return false;
    }
    
    // Skip cell types based on options
    if (cell.cell_type === 'code' && !opts.includeCode) {
      return false;
    }
    
    if (cell.cell_type === 'markdown' && !opts.includeMarkdown) {
      return false;
    }
    
    return true;
  });
  
  // If selection mode is enabled, filter to only selected cells
  if (opts.selectionMode && opts.selectedCells.length > 0) {
    filteredCells = opts.selectedCells.map(index => notebook.cells[index])
                                      .filter(cell => cell !== undefined);
  }
  
  console.log(`Processing ${filteredCells.length} cells after filtering`);
  
  // Process each non-empty cell
  filteredCells.forEach((cell, index) => {
    // Add separator between cells
    if (index > 0) {
      content += '\n\n' + '-'.repeat(40) + '\n\n';
    }
    
    if (cell.cell_type === 'markdown') {
      // For markdown cells, just add the content
      content += processSource(cell.source);
    } else if (cell.cell_type === 'code') {
      // For code cells, wrap in code blocks for clarity
      content += '```\n' + processSource(cell.source) + '\n```';
    } else if (cell.cell_type === 'raw') {
      // For raw cells, add as-is
      content += processSource(cell.source);
    }
  });
  
  // Estimate token count
  const tokenCount = estimateTokenCount(content);
  
  return { text: content, tokenCount: tokenCount };
}

/**
 * Process source content (handle both string and array formats)
 */
function processSource(source) {
  if (!source) return '';
  
  if (Array.isArray(source)) {
    return source.join('');
  }
  return source;
}

/**
 * Estimate token count for the text
 */
function estimateTokenCount(text) {
  if (!text) return 0;
  
  // GPT models use ~4 chars per token for English
  // This is a rough estimate that works surprisingly well
  const charCount = text.length;
  return Math.ceil(charCount / 4);
}

/**
 * Split content into chunks based on token limit
 */
function chunkContent(content, tokenLimit) {
  if (!content) return [];
  
  const chunks = [];
  const lines = content.split('\n');
  let currentChunk = '';
  let currentTokens = 0;
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineTokens = estimateTokenCount(line);
    
    // If a single line exceeds token limit, we need to split it
    if (lineTokens > tokenLimit) {
      // Add current chunk if not empty
      if (currentChunk) {
        chunks.push(currentChunk);
        currentChunk = '';
        currentTokens = 0;
      }
      
      // Split the large line into smaller pieces
      let remainingLine = line;
      while (remainingLine) {
        const chunkSize = Math.floor(tokenLimit * 0.9 * 4); // Convert to chars
        const part = remainingLine.substring(0, chunkSize);
        remainingLine = remainingLine.substring(chunkSize);
        
        chunks.push(part);
      }
    } 
    // Check if adding this line would exceed the limit
    else if (currentTokens + lineTokens + 1 > tokenLimit) { // +1 for newline
      chunks.push(currentChunk);
      currentChunk = line;
      currentTokens = lineTokens;
    } 
    // Add to current chunk
    else {
      if (currentChunk) currentChunk += '\n';
      currentChunk += line;
      currentTokens += lineTokens + 1; // +1 for newline
    }
  }
  
  // Add the last chunk if not empty
  if (currentChunk) {
    chunks.push(currentChunk);
  }
  
  return chunks;
}

/**
 * Create downloads for chunked content
 */
function createChunkedDownloads(chunks, modelName) {
  if (!chunks || chunks.length === 0) return;
  
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  
  // Send each chunk for download
  chunks.forEach((chunk, index) => {
    const chunkNumber = index + 1;
    const filename = `notebook-${modelName}-part${chunkNumber}-of-${chunks.length}-${timestamp}.txt`;
    
    const header = `--- PART ${chunkNumber} OF ${chunks.length} ---\n\n`;
    
    chrome.runtime.sendMessage({
      action: 'downloadText',
      text: header + chunk,
      filename: filename
    });
  });
}

/**
 * Generate a filename for the downloaded text
 */
function getFilename() {
  // Try to get filename from URL
  const urlMatch = window.location.href.match(/\/([^\/]+\.ipynb)/);
  if (urlMatch && urlMatch[1]) {
    return urlMatch[1].replace('.ipynb', '-for-llm.txt');
  }
  
  // Use page title
  if (document.title && document.title.trim() !== '') {
    return document.title.replace(/[^\w\s-]/g, '')
                         .trim()
                         .replace(/\s+/g, '-')
                         .toLowerCase() + '-for-llm.txt';
  }
  
  // Default fallback
  return `notebook-content-for-llm-${Date.now()}.txt`;
}