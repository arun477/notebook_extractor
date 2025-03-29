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
  } else if (request.action === 'debugExtraction') {
    diagnoseExtractionIssues()
      .then(result => {
        sendResponse(result);
      }).catch(error => {
        sendResponse({success: false, error: error.message});
      });
    return true;
  }
});

/**
 * Diagnostic function to help understand notebook structure
 */
async function diagnoseExtractionIssues() {
  console.log("NOTEBOOK EXTRACTOR DIAGNOSTICS");
  console.log("--------------------------");
  
  // Log DOM structure
  console.log("Document structure:", document.doctype ? document.doctype.name : "No doctype");
  console.log("Body classes:", document.body.className);
  
  // Check for Jupyter-specific objects
  console.log("Jupyter namespace available:", typeof window.Jupyter !== 'undefined');
  console.log("Jupyter notebook object:", window.Jupyter && window.Jupyter.notebook ? 'Present' : 'Not found');
  
  // Log potential cells found by different methods
  const jpCells = document.querySelectorAll('.jp-Cell').length;
  const classicCells = document.querySelectorAll('.cell').length;
  const codeMirrorBlocks = document.querySelectorAll('.CodeMirror').length;
  
  console.log("Potential cells by class:", {
    "jp-Cell": jpCells,
    "classic cell": classicCells,
    "CodeMirror": codeMirrorBlocks
  });
  
  // Try to detect which Jupyter variant is running
  let variant = "Unknown";
  if (document.querySelector('#jupyter-main-app')) {
    variant = "JupyterLab";
  } else if (document.querySelector('#notebook')) {
    variant = "Classic Notebook";
  } else if (document.querySelector('.colab-root')) {
    variant = "Google Colab";
  }
  
  console.log("Detected Jupyter variant:", variant);
  
  // Check for page URL patterns
  console.log("Current URL:", window.location.href);
  console.log("Is notebook URL:", window.location.href.includes('.ipynb') || 
              window.location.href.includes('/notebooks/') || 
              window.location.href.includes('/lab/'));
  
  const diagnostics = {
    variant,
    cellCount: Math.max(jpCells, classicCells, codeMirrorBlocks),
    url: window.location.href,
    isNotebookUrl: window.location.href.includes('.ipynb') || 
                   window.location.href.includes('/notebooks/') || 
                   window.location.href.includes('/lab/')
  };
  
  console.log("Diagnostics:", diagnostics);
  return diagnostics;
}

/**
 * Main function to extract notebook content with options
 * @param {string} outputAction - What to do with the content ('download' or 'copy')
 * @param {Object} options - Extraction options
 */
async function extractNotebookContent(outputAction = 'download', options = {}) {
  try {
    console.log("Starting extraction process with options:", options);
    
    // Try each method in strict sequence, returning after the first success
    
    // ATTEMPT 1: Direct file approach
    console.log("Attempting direct file extraction...");
    const notebookContent = await tryDirectFileExtraction();
    
    if (notebookContent && notebookContent.cells) {
      const { text, tokenCount } = processNotebookContent(notebookContent, options);
      console.log(`Extracted ${text.length} characters using direct file approach`);
      
      // Handle output based on requested action
      if (outputAction === 'copy') {
        return { success: true, text: text, tokenCount: tokenCount, method: 'direct' };
      } else {
        // For download, use a unique method identifier
        chrome.runtime.sendMessage({
          action: 'downloadText',
          text: text,
          filename: getFilename(),
          source: 'direct_file' // Add this identifier
        });
        return { success: true, tokenCount: tokenCount, method: 'direct' };
      }
    }
    
    // ATTEMPT 2: Jupyter API approach
    console.log("Direct file extraction failed. Trying Jupyter API...");
    if (window.Jupyter && window.Jupyter.notebook) {
      const notebook = window.Jupyter.notebook.toJSON();
      if (notebook && notebook.cells) {
        const { text, tokenCount } = processNotebookContent(notebook, options);
        console.log(`Extracted ${text.length} characters using Jupyter API`);
        
        if (outputAction === 'copy') {
          return { success: true, text: text, tokenCount: tokenCount, method: 'api' };
        } else {
          chrome.runtime.sendMessage({
            action: 'downloadText',
            text: text,
            filename: getFilename(),
            source: 'jupyter_api' // Add this identifier
          });
          return { success: true, tokenCount: tokenCount, method: 'api' };
        }
      }
    }
    
    // ATTEMPT 3: DOM parsing (last resort)
    console.log("Jupyter API extraction failed. Falling back to DOM parsing...");
    const notebook = await tryExtractNotebook();
    
    if (!notebook || !notebook.cells || notebook.cells.length === 0) {
      return {success: false, error: 'No notebook content found on this page'};
    }
    
    const { text, tokenCount } = extractCellsWithOptions(notebook, options);
    console.log(`Extracted ${text.length} characters using DOM extraction`);
    
    if (outputAction === 'copy') {
      return {success: true, text: text, tokenCount: tokenCount, method: 'dom'};
    } else {
      chrome.runtime.sendMessage({
        action: 'downloadText',
        text: text,
        filename: getFilename(),
        source: 'dom_parsing' // Add this identifier
      });
      return {success: true, tokenCount: tokenCount, method: 'dom'};
    }
  } catch (error) {
    console.error('Extraction error:', error);
    return {success: false, error: error.message};
  }
}
/**
 * Try to extract notebook directly from the file
 */
async function tryDirectFileExtraction() {
  try {
    // Convert from UI URL to direct file URL
    let notebookUrl = window.location.href;
    
    // Handle different Jupyter interfaces
    if (notebookUrl.includes('/notebooks/')) {
      notebookUrl = notebookUrl.replace('/notebooks/', '/files/').split('?')[0];
    } else if (notebookUrl.includes('/lab/')) {
      // Extract the file path from JupyterLab URL structure
      const match = notebookUrl.match(/\/lab\/tree\/(.+?)([\?#]|$)/);
      if (match) {
        notebookUrl = `${window.location.origin}/files/${match[1]}`;
      }
    }
    
    // Make sure we have an .ipynb URL
    if (notebookUrl.includes('.ipynb')) {
      console.log("Attempting to fetch notebook from:", notebookUrl);
      
      try {
        const response = await fetch(notebookUrl);
        if (response.ok) {
          const notebook = await response.json();
          console.log("Successfully retrieved notebook file!");
          return notebook;
        } else {
          console.log("Fetch failed with status:", response.status);
        }
      } catch (error) {
        console.log("Could not fetch notebook file directly:", error.message);
      }
    } else {
      console.log("URL does not contain .ipynb pattern:", notebookUrl);
    }
  } catch (error) {
    console.error("Error in direct file extraction:", error);
  }
  
  return null;
}

/**
 * Process notebook content from JSON format
 */
function processNotebookContent(notebook, options) {
  let content = '';
  const defaultOptions = {
    includeCode: true,
    includeMarkdown: true,
    includeRaw: true,
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
    
    if (cell.cell_type === 'raw' && !opts.includeRaw) {
      return false;
    }
    
    return true;
  });
  
  // If selection mode is enabled, filter to only selected cells
  if (opts.selectionMode && opts.selectedCells.length > 0) {
    filteredCells = opts.selectedCells.map(index => notebook.cells[index])
                                      .filter(cell => cell !== undefined);
  }
  
  console.log(`Processing ${filteredCells.length} cells after filtering out of ${notebook.cells.length} total cells`);
  
  // Process each non-empty cell
  filteredCells.forEach((cell, index) => {
    // Add separator between cells
    if (index > 0) {
      content += '\n\n' + '-'.repeat(40) + '\n\n';
    }
    
    // Convert cell source to string if it's an array
    const source = Array.isArray(cell.source) ? cell.source.join('') : cell.source;
    
    if (cell.cell_type === 'markdown') {
      // For markdown cells, just add the content
      content += source;
    } else if (cell.cell_type === 'code') {
      // For code cells, wrap in code blocks for clarity
      content += '```\n' + source + '\n```';
      
      // Add outputs if present and is a result (not just status messages)
      if (cell.outputs && cell.outputs.length > 0) {
        // Filter for meaningful outputs (executed results, not status updates)
        const meaningfulOutputs = cell.outputs.filter(output => 
          output.output_type === 'execute_result' || 
          output.output_type === 'display_data' || 
          (output.output_type === 'stream' && output.text && output.text.join('').trim().length > 0) ||
          output.output_type === 'error'
        );
        
        if (meaningfulOutputs.length > 0) {
          content += '\n\n';
          
          meaningfulOutputs.forEach(output => {
            if (output.output_type === 'stream' && output.text) {
              content += output.text.join('');
            } else if (output.output_type === 'execute_result' && output.data && output.data['text/plain']) {
              content += output.data['text/plain'].join('');
            } else if (output.output_type === 'display_data') {
              if (output.data && output.data['text/plain']) {
                content += output.data['text/plain'].join('');
              } else if (output.data && output.data['image/png']) {
                content += "[Image output]\n";
              } else if (output.data && output.data['audio/wav']) {
                content += "[Audio output]\n";
              }
            } else if (output.output_type === 'error' && output.traceback) {
              content += output.traceback.join('\n');
            }
          });
        }
      }
    } else if (cell.cell_type === 'raw') {
      // For raw cells, add as plain text
      content += source;
    }
  });
  
  // Estimate token count
  const tokenCount = estimateTokenCount(content);
  
  return { text: content, tokenCount: tokenCount };
}

/**
 * Get list of cells from the notebook
 */
async function getCellList() {
  try {
    // First try direct file extraction
    const notebookContent = await tryDirectFileExtraction();
    
    if (notebookContent && notebookContent.cells) {
      // Return simplified cell info
      const cells = notebookContent.cells.map(cell => {
        const source = Array.isArray(cell.source) ? cell.source.join('') : (cell.source || '');
        return {
          cell_type: cell.cell_type || 'unknown',
          source: source,
          isEmpty: source.trim() === ''
        };
      });
      
      return {success: true, cells: cells};
    }
    
    // Next try Jupyter API
    if (window.Jupyter && window.Jupyter.notebook) {
      const notebook = window.Jupyter.notebook.toJSON();
      if (notebook && notebook.cells) {
        const cells = notebook.cells.map(cell => {
          const source = Array.isArray(cell.source) ? cell.source.join('') : (cell.source || '');
          return {
            cell_type: cell.cell_type || 'unknown',
            source: source,
            isEmpty: source.trim() === ''
          };
        });
        
        return {success: true, cells: cells};
      }
    }
    
    // Fall back to DOM extraction
    let notebook = await tryExtractNotebook();
    
    if (!notebook || !notebook.cells || notebook.cells.length === 0) {
      return {success: false, error: 'No notebook content found on this page'};
    }
    
    // Return simplified cell info
    const cells = notebook.cells.map(cell => ({
      cell_type: cell.cell_type || 'unknown',
      source: processSource(cell.source),
      isEmpty: isCellEmpty(cell)
    }));
    
    return {success: true, cells: cells};
  } catch (error) {
    console.error('Error getting cell list:', error);
    return {success: false, error: error.message};
  }
}

/**
 * Try all possible methods to extract notebook content from DOM
 * (This is the fallback method when direct file access fails)
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
    const cells = [];
    
    // Check for all variations of JupyterLab cells (including newer versions)
    const jupyterLabMarkdownCells = document.querySelectorAll(
      '.jp-MarkdownCell, .jp-Notebook-cell[data-type="markdown"], .jp-Cell[data-jp-type="markdown"], div[data-mime-type="text/markdown"]'
    );
    
    const jupyterLabCodeCells = document.querySelectorAll(
      '.jp-CodeCell, .jp-Notebook-cell[data-type="code"], .jp-Cell[data-jp-type="code"], div[data-mime-type="application/x-ipynb+json"]'
    );
    
    const jupyterLabRawCells = document.querySelectorAll(
      '.jp-RawCell, .jp-Notebook-cell[data-type="raw"], .jp-Cell[data-jp-type="raw"]'
    );
    
    if (jupyterLabMarkdownCells.length > 0 || jupyterLabCodeCells.length > 0 || jupyterLabRawCells.length > 0) {
      console.log(`Found JupyterLab cells: ${jupyterLabMarkdownCells.length} markdown, ${jupyterLabCodeCells.length} code, ${jupyterLabRawCells.length} raw`);
      
      // Process markdown cells
      jupyterLabMarkdownCells.forEach(cell => {
        const content = 
          cell.querySelector('.jp-RenderedMarkdown') || 
          cell.querySelector('.jp-Cell-inputArea') ||
          cell;
          
        if (content) {
          cells.push({
            cell_type: 'markdown',
            source: content.innerText || content.textContent
          });
        }
      });
      
      // Process code cells
      jupyterLabCodeCells.forEach(cell => {
        const codeContent = 
          cell.querySelector('.jp-InputArea-editor') || 
          cell.querySelector('.jp-Cell-inputArea .jp-InputArea-editor') ||
          cell.querySelector('.jp-CodeMirrorEditor') ||
          cell.querySelector('pre');
          
        if (codeContent) {
          cells.push({
            cell_type: 'code',
            source: codeContent.innerText || codeContent.textContent
          });
        }
      });
      
      // Process raw cells
      jupyterLabRawCells.forEach(cell => {
        const content = 
          cell.querySelector('.jp-InputArea-editor') || 
          cell.querySelector('.jp-Cell-inputArea') ||
          cell;
          
        if (content) {
          cells.push({
            cell_type: 'raw',
            source: content.innerText || content.textContent
          });
        }
      });
      
      if (cells.length > 0) {
        console.log(`Extracted ${cells.length} cells from JupyterLab DOM`);
        return { cells: cells };
      }
    }
    
    // Check for Classic Notebook cells
    const classicMarkdownCells = document.querySelectorAll('.text_cell, .markdown_cell');
    const classicCodeCells = document.querySelectorAll('.code_cell');
    const classicRawCells = document.querySelectorAll('.raw_cell');
    
    if (classicMarkdownCells.length > 0 || classicCodeCells.length > 0 || classicRawCells.length > 0) {
      console.log(`Found Classic Notebook cells: ${classicMarkdownCells.length} markdown, ${classicCodeCells.length} code, ${classicRawCells.length} raw`);
      
      // Process markdown cells
      classicMarkdownCells.forEach(cell => {
        const content = cell.querySelector('.text_cell_render') || cell.querySelector('.rendered_html') || cell;
        if (content) {
          cells.push({
            cell_type: 'markdown',
            source: content.innerText || content.textContent
          });
        }
      });
      
      // Process code cells (get only input, not output)
      classicCodeCells.forEach(cell => {
        const codeContent = cell.querySelector('.input_area') || cell.querySelector('.CodeMirror') || cell;
        if (codeContent) {
          cells.push({
            cell_type: 'code',
            source: codeContent.innerText || codeContent.textContent
          });
        }
      });
      
      // Process raw cells
      classicRawCells.forEach(cell => {
        const content = cell.querySelector('.input_area') || cell;
        if (content) {
          cells.push({
            cell_type: 'raw',
            source: content.innerText || content.textContent
          });
        }
      });
      
      if (cells.length > 0) {
        console.log(`Extracted ${cells.length} cells from Classic Notebook DOM`);
        return { cells: cells };
      }
    }
    
    // Check for Google Colab cells
    const colabCells = document.querySelectorAll('.cell, .notebook-cell');
    
    if (colabCells.length > 0) {
      console.log(`Found ${colabCells.length} potential Colab cells`);
      
      colabCells.forEach(cell => {
        // Check for text cells
        const textCell = cell.querySelector('.text_cell_render') || cell.querySelector('.markdown-cell');
        if (textCell) {
          cells.push({
            cell_type: 'markdown',
            source: textCell.innerText || textCell.textContent
          });
          return;
        }
        
        // Check for code cells
        const codeCell = cell.querySelector('.input') || cell.querySelector('.code-cell');
        if (codeCell) {
          const codeBlock = 
            codeCell.querySelector('pre') || 
            codeCell.querySelector('.CodeMirror-code') ||
            codeCell.querySelector('.view-line');
            
          if (codeBlock) {
            cells.push({
              cell_type: 'code',
              source: codeBlock.innerText || codeBlock.textContent
            });
          }
        }
        
        // Check for raw cells
        const rawCell = cell.querySelector('.raw-cell');
        if (rawCell) {
          cells.push({
            cell_type: 'raw',
            source: rawCell.innerText || rawCell.textContent
          });
        }
      });
      
      if (cells.length > 0) {
        console.log(`Extracted ${cells.length} cells from Colab DOM`);
        return { cells: cells };
      }
    }
    
    // Method 3: Generic attempt to find code and text blocks
    const allPreElements = document.querySelectorAll('pre:not(.jp-OutputArea-output)');
    const allMarkdownElements = document.querySelectorAll(
      'div[class*="markdown"], div[class*="text_cell"], div[class*="rendered_html"]'
    );
    
    if (allPreElements.length > 0 || allMarkdownElements.length > 0) {
      console.log(`Found generic elements: ${allMarkdownElements.length} markdown-like, ${allPreElements.length} code-like`);
      
      // Process markdown-like elements
      allMarkdownElements.forEach(el => {
        // Skip if already processed
        if (el.closest('.jp-MarkdownCell') || el.closest('.text_cell')) {
          return;
        }
        
        cells.push({
          cell_type: 'markdown',
          source: el.innerText || el.textContent
        });
      });
      
      // Process code-like elements
      allPreElements.forEach(el => {
        // Skip if already processed or if it's part of output
        if (el.closest('.jp-CodeCell') || el.closest('.code_cell') || el.closest('.jp-OutputArea')) {
          return;
        }
        
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
        console.log(`Extracted ${cells.length} cells from generic DOM elements`);
        return { cells: cells };
      }
    }
    
    // Method 4: Most aggressive approach - check for any code blocks and headings
    const codeBlocks = document.querySelectorAll('pre, code, div[class*="code"]');
    const headings = document.querySelectorAll('h1, h2, h3, h4, h5, h6, p');
    
    if (codeBlocks.length > 0 || headings.length > 0) {
      console.log(`Last resort: Found ${headings.length} text blocks, ${codeBlocks.length} code blocks`);
      
      // Add text blocks as markdown
      headings.forEach(el => {
        // Skip if empty or if it's already been processed
        if (!el.textContent.trim() || el.closest('.jp-RenderedMarkdown') || el.closest('.text_cell_render')) {
          return;
        }
        
        cells.push({
          cell_type: 'markdown',
          source: el.innerText || el.textContent
        });
      });
      
      // Add code blocks
      codeBlocks.forEach(el => {
        // Skip if empty or already processed
        if (!el.textContent.trim() || el.closest('.jp-CodeCell') || el.closest('.code_cell') || el.closest('.jp-OutputArea-output')) {
          return;
        }
        
        cells.push({
          cell_type: 'code',
          source: el.innerText || el.textContent
        });
      });
      
      if (cells.length > 0) {
        console.log(`Extracted ${cells.length} cells from fallback method`);
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
  
  let source;
  if (Array.isArray(cell.source)) {
    source = cell.source.join('');
  } else {
    source = String(cell.source);
  }
  
  // More intelligent emptiness check
  // Not empty if it contains actual content, images, or special formatting
  if (source.trim() === '') return true;
  
  // If it only contains whitespace, newlines, or common empty cell markers
  if (/^\s*(\[\])?\s*$/.test(source)) return true;
  
  return false;
}

/**
 * Extract cells based on provided options
 */
function extractCellsWithOptions(notebook, options) {
  let content = '';
  const defaultOptions = {
    includeCode: true,
    includeMarkdown: true,
    includeRaw: true,
    skipEmpty: true,
    selectedCells: [],
    selectionMode: false
  };
  
  // Merge defaults with provided options
  const opts = {...defaultOptions, ...options};
  
  console.log("Extraction options:", opts);
  
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
    
    if (cell.cell_type === 'raw' && !opts.includeRaw) {
      return false;
    }
    
    return true;
  });
  
  // If selection mode is enabled, filter to only selected cells
  if (opts.selectionMode && opts.selectedCells.length > 0) {
    filteredCells = opts.selectedCells.map(index => notebook.cells[index])
                                      .filter(cell => cell !== undefined);
  }
  
  console.log(`Processing ${filteredCells.length} cells after filtering out of ${notebook.cells.length} total cells`);
  
  // Process each non-empty cell
  filteredCells.forEach((cell, index) => {
    // Add separator between cells
    if (index > 0) {
      content += '\n\n' + '-'.repeat(40) + '\n\n';
    }
    
    // Determine cell type (default to 'code' if undefined)
    const cellType = cell.cell_type || 'code';
    
    if (cellType === 'markdown') {
      // For markdown cells, just add the content
      content += processSource(cell.source);
    } else if (cellType === 'code') {
      // For code cells, wrap in code blocks for clarity
      content += '```\n' + processSource(cell.source) + '\n```';
    } else if (cellType === 'raw') {
      // For raw cells, add as-is with a comment
      content += '<!-- Raw Cell -->\n' + processSource(cell.source);
    } else {
      // For any other cell types, add as plain text
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
  
  // Handle different source formats
  if (Array.isArray(source)) {
    return source.join('');
  } else if (typeof source === 'object' && source.text) {
    // Some formats might have source as an object with text property
    return source.text;
  }
  
  return String(source);
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