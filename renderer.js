const { ipcRenderer } = require('electron');

let mediaFiles = [];
let config = {};
let currentIndex = 0;
let container = null;
let isPlaying = false;

// Listen for media files from main process
ipcRenderer.on('media-files', async (event, data) => {
  mediaFiles = data.files;
  config = data.config;
  
  console.log(`Loaded ${mediaFiles.length} media files`);
  
  // Hide loading message
  const loading = document.getElementById('loading');
  if (loading) {
    loading.style.display = 'none';
  }
  
  container = document.getElementById('slideshow-container');
  
  if (mediaFiles.length === 0) {
    showMessage('No media files found in the configured directory.');
    return;
  }
  
  // Shuffle the media files for random playback
  shuffleArray(mediaFiles);
  
  // Start the slideshow
  startSlideshow();
});

function shuffleArray(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
}

async function startSlideshow() {
  if (isPlaying) return;
  isPlaying = true;
  
  await showNextMedia();
}

async function showNextMedia() {
  if (mediaFiles.length === 0) return;
  
  const mediaFile = mediaFiles[currentIndex];
  currentIndex = (currentIndex + 1) % mediaFiles.length;
  
  try {
    if (mediaFile.type === 'raw') {
      await showRawImage(mediaFile);
    } else if (mediaFile.type === 'image') {
      await showImage(mediaFile.path);
    } else if (mediaFile.type === 'video') {
      await showVideo(mediaFile.path);
    }
  } catch (error) {
    console.error('Error showing media:', error);
    // Skip to next media on error
    setTimeout(() => showNextMedia(), 500);
  }
}

async function showRawImage(rawFile) {
  try {
    // Request conversion from main process
    const jpegPath = await ipcRenderer.invoke('convert-raw', rawFile);
    
    if (jpegPath) {
      await showImage(jpegPath);
    } else {
      // Conversion failed, skip to next
      console.warn('Failed to convert RAW file:', rawFile.path);
      setTimeout(() => showNextMedia(), 500);
    }
  } catch (error) {
    console.error('Error converting RAW file:', error);
    setTimeout(() => showNextMedia(), 500);
  }
}

async function showImage(imagePath) {
  return new Promise((resolve, reject) => {
    const img = document.createElement('img');
    img.className = 'media-item';
    img.src = imagePath;
    
    img.onload = () => {
      // Remove previous media items after transition
      const previousItems = container.querySelectorAll('.media-item.active');
      
      container.appendChild(img);
      
      // Force reflow to ensure transition works
      img.offsetHeight;
      img.classList.add('active');
      
      // Remove previous items after fade-in completes
      setTimeout(() => {
        previousItems.forEach(item => {
          item.remove();
        });
      }, 1000);
      
      // Schedule next media
      setTimeout(() => {
        showNextMedia();
        resolve();
      }, config.slideDuration || 5000);
    };
    
    img.onerror = () => {
      console.error('Failed to load image:', imagePath);
      img.remove();
      reject(new Error('Failed to load image'));
    };
  });
}

async function showVideo(videoPath) {
  return new Promise((resolve) => {
    const video = document.createElement('video');
    video.className = 'media-item';
    video.src = videoPath;
    video.muted = true;
    video.autoplay = true;
    
    video.onloadeddata = () => {
      // Remove previous media items
      const previousItems = container.querySelectorAll('.media-item.active');
      
      container.appendChild(video);
      
      // Force reflow
      video.offsetHeight;
      video.classList.add('active');
      
      // Remove previous items after fade-in
      setTimeout(() => {
        previousItems.forEach(item => {
          item.remove();
        });
      }, 1000);
      
      // Calculate how long to show the video
      const maxDuration = config.videoMaxDuration || 30000;
      const videoDuration = Math.min(video.duration * 1000, maxDuration);
      
      video.play().catch(err => {
        console.error('Error playing video:', err);
      });
      
      // Schedule next media after video duration or max duration
      setTimeout(() => {
        video.pause();
        showNextMedia();
        resolve();
      }, videoDuration || 10000); // Fallback to 10 seconds if duration unknown
    };
    
    video.onerror = () => {
      console.error('Failed to load video:', videoPath);
      video.remove();
      // Skip to next on error
      setTimeout(() => {
        showNextMedia();
        resolve();
      }, 500);
    };
  });
}

function showMessage(message) {
  const messageDiv = document.createElement('div');
  messageDiv.style.cssText = `
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    color: white;
    font-family: Arial, sans-serif;
    font-size: 24px;
    text-align: center;
    padding: 20px;
  `;
  messageDiv.textContent = message;
  container.appendChild(messageDiv);
}

// Exit on click
document.addEventListener('click', () => {
  window.close();
});
