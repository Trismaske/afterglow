# Afterglow

An Electron-based cross-platform screensaver app that displays RAW files (with their edits applied from sidecar XMPs) as well as videos (muted) and normal photos.

## Features

- **RAW File Support**: Displays RAW image files (.CR2, .NEF, .ARW, .DNG, .ORF, .RW2, .PEF, .SRW, .RAF) with XMP sidecar edits applied using darktable-cli
- **Video Playback**: Plays video files (.MP4, .MOV, .AVI, .MKV, .WEBM, .M4V) with audio muted
- **Standard Images**: Displays common image formats (.JPG, .PNG, .GIF, .BMP, .WEBP, .SVG)
- **Cross-Platform**: Works on Windows, macOS, and Linux
- **Fullscreen Slideshow**: Automatically cycles through media with smooth transitions
- **Smart Caching**: Converts RAW files to JPEG and caches them for faster subsequent loading

## Prerequisites

For RAW file support, you need to have [darktable](https://www.darktable.org/) installed on your system:

- **Linux**: `sudo apt-get install darktable` (Ubuntu/Debian) or equivalent for your distribution
- **macOS**: `brew install darktable` or download from the darktable website
- **Windows**: Download and install from the darktable website

If darktable-cli is not available, the application will still work but will skip RAW files.

## Installation

1. Clone the repository:
```bash
git clone https://github.com/Trismaske/afterglow.git
cd afterglow
```

2. Install dependencies:
```bash
npm install
```

## Usage

### Running the Application

By default, the application scans the Pictures folder in your home directory:

```bash
npm start
```

### Configuring Media Directory

You can specify a custom media directory using the `AFTERGLOW_MEDIA_DIR` environment variable:

```bash
AFTERGLOW_MEDIA_DIR=/path/to/your/photos npm start
```

On Windows:
```cmd
set AFTERGLOW_MEDIA_DIR=C:\path\to\your\photos
npm start
```

### Controls

- **Press any key** to exit the screensaver
- **Click anywhere** to exit the screensaver

## Configuration

You can modify the following settings in `main.js`:

- `slideDuration`: Time in milliseconds to display each image (default: 5000)
- `videoMaxDuration`: Maximum time in milliseconds to play each video (default: 30000)

## How It Works

1. **Scanning**: The application recursively scans the configured media directory for supported files
2. **RAW Processing**: When a RAW file is encountered:
   - Checks for an XMP sidecar file (filename.ext.xmp or filename.xmp)
   - Uses darktable-cli to convert the RAW file to JPEG with XMP edits applied
   - Caches the converted JPEG in the user data directory
3. **Playback**: Media files are shuffled and displayed in random order
4. **Transitions**: Smooth fade transitions between media items
5. **Videos**: Played muted with a maximum duration limit

## Project Structure

```
afterglow/
├── main.js           # Electron main process (file scanning, RAW conversion)
├── renderer.html     # HTML structure for the slideshow
├── renderer.js       # Renderer process (slideshow logic)
├── package.json      # Node.js dependencies and scripts
└── README.md         # This file
```

## Supported File Formats

### RAW Files
- Canon: .CR2
- Nikon: .NEF
- Sony: .ARW
- Adobe: .DNG
- Olympus: .ORF
- Panasonic: .RW2
- Pentax: .PEF
- Samsung: .SRW
- Fujifilm: .RAF

### Images
- JPEG (.jpg, .jpeg)
- PNG (.png)
- GIF (.gif)
- BMP (.bmp)
- WebP (.webp)
- SVG (.svg)

### Videos
- MP4 (.mp4)
- MOV (.mov)
- AVI (.avi)
- MKV (.mkv)
- WebM (.webm)
- M4V (.m4v)

## Development

### Testing

Create a test media directory with sample files:
```bash
mkdir test-media
# Add your photos, RAW files, and videos to this directory
AFTERGLOW_MEDIA_DIR=./test-media npm start
```

## License

See LICENSE file for details.

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

