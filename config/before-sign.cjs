const path = require('path');
const fs = require('fs');

/**
 * After pack hook - clean invalid symlinks after packing, before signing
 * Also fixes Windows venv paths that are hardcoded during build
 */
exports.default = async function afterPack(context) {
  const appOutDir = context.appOutDir;
  const appName = context.packager.appInfo.productName;
  const isMac = process.platform === 'darwin';
  const isWin = process.platform === 'win32';

  let appPath, resourcesPath, prebuiltPath;

  if (isMac) {
    appPath = path.join(appOutDir, `${appName}.app`);
    if (!fs.existsSync(appPath)) {
      console.log('App bundle not found, skipping cleanup');
      return;
    }
    resourcesPath = path.join(appPath, 'Contents', 'Resources');
    prebuiltPath = path.join(resourcesPath, 'prebuilt');
  } else if (isWin) {
    // Windows: app is in appOutDir directly
    appPath = appOutDir;
    resourcesPath = path.join(appPath, 'resources');
    prebuiltPath = path.join(resourcesPath, 'prebuilt');
  } else {
    // Linux or other platforms
    return;
  }

  if (!fs.existsSync(prebuiltPath)) {
    return;
  }

  console.log('🧹 Cleaning invalid paths and cache directories before signing...');

  // Remove .npm-cache directories (should not be packaged)
  function removeNpmCache(dir) {
    if (!fs.existsSync(dir)) {
      return;
    }

    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);

        try {
          if (entry.name === '.npm-cache' && entry.isDirectory()) {
            console.log(`Removing .npm-cache directory: ${fullPath}`);
            fs.rmSync(fullPath, { recursive: true, force: true });
          } else if (entry.isDirectory()) {
            removeNpmCache(fullPath);
          }
        } catch (error) {
          // Ignore errors
        }
      }
    } catch (error) {
      // Ignore errors
    }
  }

  removeNpmCache(prebuiltPath);

  // Fix Windows venv pyvenv.cfg - remove hardcoded Python paths
  if (isWin) {
    const pyvenvCfgPath = path.join(prebuiltPath, 'venv', 'pyvenv.cfg');
    if (fs.existsSync(pyvenvCfgPath)) {
      try {
        console.log('🔧 Fixing Windows venv pyvenv.cfg...');
        let content = fs.readFileSync(pyvenvCfgPath, 'utf-8');
        const lines = content.split('\n');
        const newLines = [];

        for (const line of lines) {
          // Remove or comment out 'home' line that contains absolute path
          // This allows uv to auto-discover Python at runtime
          if (line.trim().startsWith('home =')) {
            // Check if it's an absolute path (starts with drive letter on Windows)
            const match = line.match(/home\s*=\s*(.+)/);
            if (match && match[1].trim().match(/^[A-Za-z]:/)) {
              console.log(`  Removing hardcoded Python path: ${match[1].trim()}`);
              // Skip this line - uv will auto-discover Python
              continue;
            }
          }
          newLines.push(line);
        }

        fs.writeFileSync(pyvenvCfgPath, newLines.join('\n'), 'utf-8');
        console.log('✅ Fixed pyvenv.cfg');
      } catch (error) {
        console.warn(`Warning: Could not fix pyvenv.cfg: ${error.message}`);
      }
    }

    // Also check Scripts/python.exe and Scripts/pythonw.exe - these might be hardcoded
    // On Windows, these should be actual executables, not symlinks pointing to build machine
    const venvScriptsDir = path.join(prebuiltPath, 'venv', 'Scripts');
    if (fs.existsSync(venvScriptsDir)) {
      const pythonExe = path.join(venvScriptsDir, 'python.exe');
      const pythonwExe = path.join(venvScriptsDir, 'pythonw.exe');

      // Check if these are symlinks pointing outside the bundle
      [pythonExe, pythonwExe].forEach(exePath => {
        if (fs.existsSync(exePath)) {
          try {
            const stats = fs.lstatSync(exePath);
            if (stats.isSymbolicLink()) {
              const target = fs.readlinkSync(exePath);
              const resolvedPath = path.resolve(path.dirname(exePath), target);
              const bundlePath = path.resolve(appPath);

              if (!resolvedPath.startsWith(bundlePath)) {
                console.log(`  Removing invalid symlink: ${exePath} -> ${target}`);
                fs.unlinkSync(exePath);
              }
            }
          } catch (error) {
            // Ignore errors
          }
        }
      });
    }
  }

  // Remove flac-mac binary (uses outdated SDK, causes notarization issues) - macOS only
  if (isMac) {
    const venvLibPath = path.join(prebuiltPath, 'venv', 'lib');
    if (fs.existsSync(venvLibPath)) {
      try {
        const entries = fs.readdirSync(venvLibPath, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory() && entry.name.startsWith('python')) {
            const flacMacPath = path.join(venvLibPath, entry.name, 'site-packages', 'speech_recognition', 'flac-mac');
            if (fs.existsSync(flacMacPath)) {
              console.log(`Removing flac-mac binary (outdated SDK): ${flacMacPath}`);
              try {
                fs.unlinkSync(flacMacPath);
              } catch (error) {
                console.warn(`Warning: Could not remove flac-mac: ${error.message}`);
              }
            }
          }
        }
      } catch (error) {
        // Ignore errors
      }
    }

    // Clean Python symlinks in venv/bin (macOS/Linux only)
    const venvBinDir = path.join(prebuiltPath, 'venv', 'bin');
    if (fs.existsSync(venvBinDir)) {
      const pythonNames = ['python', 'python3', 'python3.10', 'python3.11', 'python3.12'];
      const bundlePath = path.resolve(appPath);

      for (const pythonName of pythonNames) {
        const pythonSymlink = path.join(venvBinDir, pythonName);

        if (fs.existsSync(pythonSymlink)) {
          try {
            const stats = fs.lstatSync(pythonSymlink);
            if (stats.isSymbolicLink()) {
              const target = fs.readlinkSync(pythonSymlink);
              const resolvedPath = path.resolve(path.dirname(pythonSymlink), target);

              // If symlink points outside bundle, remove it
              if (!resolvedPath.startsWith(bundlePath)) {
                console.log(`  Removing invalid ${pythonName} symlink: ${target}`);
                fs.unlinkSync(pythonSymlink);
              }
            }
          } catch (error) {
            console.warn(`Warning: Could not process ${pythonName} symlink: ${error.message}`);
          }
        }
      }
    }
  }

  // Recursively clean other invalid symlinks
  function cleanSymlinks(dir, bundleRoot) {
    if (!fs.existsSync(dir)) {
      return;
    }

    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);

        try {
          if (entry.isSymbolicLink()) {
            const target = fs.readlinkSync(fullPath);
            const resolvedPath = path.resolve(path.dirname(fullPath), target);
            const bundlePath = path.resolve(bundleRoot);

            if (!fs.existsSync(resolvedPath) || !resolvedPath.startsWith(bundlePath)) {
              console.log(`Removing invalid symlink: ${fullPath} -> ${target}`);
              fs.unlinkSync(fullPath);
            }
          } else if (entry.isDirectory()) {
            if (entry.name === 'node_modules' || entry.name === '__pycache__') {
              continue;
            }
            cleanSymlinks(fullPath, bundleRoot);
          }
        } catch (error) {
          // Ignore errors
        }
      }
    } catch (error) {
      // Ignore errors
    }
  }

  // Only clean symlinks on macOS/Linux (Windows uses different approach)
  if (!isWin) {
    cleanSymlinks(prebuiltPath, appPath);
  }

  console.log('✅ Cleanup completed');
};
