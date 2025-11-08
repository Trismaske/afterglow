const { app, BrowserWindow, screen } = require('electron');
const path = require('path');
const fs = require('fs').promises;
const { exec } = require('child_process');
const util = require('util');

const execPromise = util.promisify(exec);

let mainWindow;

// Supported file extensions
const RAW_EXTENSIONS = ['.cr2', '.nef', '.arw', '.dng', '.orf', '.rw2', '.pef', '.srw', '.raf'];
const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.svg'];
const VIDEO_EXTENSIONS = ['.mp4', '.mov', '.avi', '.mkv', '.webm', '.m4v'];

// Configuration
const config = {
  mediaDirectory: process.env.AFTERGLOW_MEDIA_DIR || path.join(app.getPath('home'), 'Pictures'),
  cacheDirectory: path.join(app.getPath('userData'), 'cache'),
  slideDuration: 5000, // milliseconds
  videoMaxDuration: 30000, // max 30 seconds per video
};

async function createWindow() {
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width, height } = primaryDisplay.bounds;

  mainWindow = new BrowserWindow({
    width,
    height,
    fullscreen: true,
    frame: false,
    backgroundColor: '#000000',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      enableRemoteModule: true,
    },
  });

  mainWindow.loadFile('renderer.html');
  
  // Exit on any key press or mouse click
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown') {
      app.quit();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Prepare cache directory
  await ensureCacheDirectory();
  
  // Scan for media files
  const mediaFiles = await scanMediaFiles(config.mediaDirectory);
  
  // Send media files to renderer
  mainWindow.webContents.once('did-finish-load', () => {
    mainWindow.webContents.send('media-files', { files: mediaFiles, config });
  });
}

async function ensureCacheDirectory() {
  try {
    await fs.mkdir(config.cacheDirectory, { recursive: true });
  } catch (error) {
    console.error('Failed to create cache directory:', error);
  }
}

async function scanMediaFiles(directory) {
  const mediaFiles = [];
  
  try {
    await scanDirectory(directory, mediaFiles);
  } catch (error) {
    console.error('Error scanning directory:', error);
  }
  
  return mediaFiles;
}

async function scanDirectory(directory, mediaFiles, depth = 0) {
  // Limit recursion depth to prevent scanning too deep
  if (depth > 5) return;
  
  try {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    
    for (const entry of entries) {
      const fullPath = path.join(directory, entry.name);
      
      if (entry.isDirectory()) {
        // Skip hidden directories and common system directories
        if (!entry.name.startsWith('.')) {
          await scanDirectory(fullPath, mediaFiles, depth + 1);
        }
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        
        if (RAW_EXTENSIONS.includes(ext)) {
          mediaFiles.push({
            path: fullPath,
            type: 'raw',
            xmpPath: await findXmpSidecar(fullPath),
          });
        } else if (IMAGE_EXTENSIONS.includes(ext)) {
          mediaFiles.push({
            path: fullPath,
            type: 'image',
          });
        } else if (VIDEO_EXTENSIONS.includes(ext)) {
          mediaFiles.push({
            path: fullPath,
            type: 'video',
          });
        }
      }
    }
  } catch (error) {
    console.error(`Error scanning directory ${directory}:`, error);
  }
}

async function findXmpSidecar(rawFilePath) {
  const xmpPath = rawFilePath + '.xmp';
  const baseWithoutExt = rawFilePath.substring(0, rawFilePath.lastIndexOf('.'));
  const altXmpPath = baseWithoutExt + '.xmp';
  
  try {
    await fs.access(xmpPath);
    return xmpPath;
  } catch {
    try {
      await fs.access(altXmpPath);
      return altXmpPath;
    } catch {
      return null;
    }
  }
}

// Handle IPC messages
const { ipcMain } = require('electron');

ipcMain.handle('convert-raw', async (event, rawFile) => {
  return await convertRawToJpeg(rawFile);
});

async function convertRawToJpeg(rawFile) {
  const { path: rawPath, xmpPath } = rawFile;
  const fileName = path.basename(rawPath, path.extname(rawPath));
  const outputPath = path.join(config.cacheDirectory, `${fileName}.jpg`);
  
  // Check if already converted
  try {
    await fs.access(outputPath);
    return outputPath;
  } catch {
    // Need to convert
  }
  
  try {
    // Try to use darktable-cli if available
    const xmpArg = xmpPath ? xmpPath : rawPath;
    const command = `darktable-cli ${rawPath} ${xmpArg} ${outputPath} --width 3840 --height 2160 --hq true --core --conf plugins/imageio/format/jpeg/quality=95`;
    
    await execPromise(command);
    return outputPath;
  } catch (error) {
    console.error('darktable-cli not available or conversion failed:', error.message);
    
    // Fallback: return null to indicate conversion failed
    // The renderer can skip this file or show a placeholder
    return null;
  }
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
