# Jupyter to LLM Extractor

> Not yet published to chrome web store. Manual installation (currently the only option).

A Chrome extension that extracts content from Jupyter notebooks for use with large language models.

## Features

- Extract both code and markdown cells
- Filter out empty cells
- Apply prompt templates 
- Select specific cells for extraction
- Copy to clipboard or download as text file
- Dark mode support

## Installation

> **Note:** This extension is not yet available on the Chrome Web Store.

### Manual Installation (Currently the only option)
1. Download the repository as a ZIP file and extract it
2. Open Chrome and navigate to `chrome://extensions/`
3. Enable "Developer mode" (toggle in the top-right corner)
4. Click "Load unpacked" and select the extracted folder

## Usage

1. Navigate to any Jupyter notebook
2. Click the extension icon in your toolbar
3. Choose your extraction options:
   - Select which cell types to include
   - Choose a prompt template (optional)
   - Select specific cells (optional)
4. Click "Copy to Clipboard" or "Download as File"

## Development

The extension consists of four main components:

- `popup.html/js`: User interface
- `content.js`: Extracts notebook content from the page
- `background.js`: Handles file downloads
- `manifest.json`: Extension configuration

## License

MIT License
