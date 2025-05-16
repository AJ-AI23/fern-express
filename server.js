
const express = require('express');
const fileUpload = require('express-fileupload');
const cors = require('cors');
const fs = require('fs-extra');
const path = require('path');
const { execSync } = require('child_process');
const archiver = require('archiver');
const dotenv = require('dotenv');

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY; // For basic auth
const DEBUG = process.env.DEBUG === 'true';

// Middleware
app.use(cors());
app.use(express.json());
app.use(fileUpload({
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB max file size
  useTempFiles: true,
  tempFileDir: './tmp/'
}));

// Create tmp directory if it doesn't exist
fs.ensureDirSync('./tmp');

// API Key middleware
const checkApiKey = (req, res, next) => {
  const providedKey = req.headers['x-api-key'];
  
  if (!API_KEY) {
    console.warn('WARNING: No API_KEY set in environment variables');
    return next();
  }
  
  if (!providedKey || providedKey !== API_KEY) {
    return res.status(401).json({ error: 'Unauthorized - Invalid API Key' });
  }
  
  next();
};

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'OK', message: 'Fern SDK Generator Server is running' });
});

// SDK Generation endpoint
app.post('/generate', checkApiKey, async (req, res) => {
  console.log('Received SDK generation request');
  
  try {
    // Validate request
    if (!req.files || !req.files.spec) {
      return res.status(400).json({ error: 'No OpenAPI spec file provided' });
    }
    
    if (!req.body.language) {
      return res.status(400).json({ error: 'Language parameter is required' });
    }
    
    if (!req.body.packageName) {
      return res.status(400).json({ error: 'Package name is required' });
    }
    
    const language = req.body.language;
    const packageName = req.body.packageName;
    const config = req.body.config ? JSON.parse(req.body.config) : {};
    
    // Create a unique working directory
    const workDir = path.join('./tmp', `fern-${Date.now()}`);
    fs.ensureDirSync(workDir);
    
    try {
      // Save spec file
      const specFile = req.files.spec;
      const specFilePath = path.join(workDir, 'openapi.yaml');
      await specFile.mv(specFilePath);
      console.log(`Spec file saved to ${specFilePath}`);
      
      // Generate Fern configuration
      const fernConfig = generateFernConfig(language, packageName, config);
      const fernConfigPath = path.join(workDir, 'fern.config.yml');
      fs.writeFileSync(fernConfigPath, fernConfig);
      console.log('Created Fern configuration file');
      
      // Check for npx/npm installation
      try {
        console.log('Verifying npm/npx availability...');
        execSync('npm --version', { stdio: DEBUG ? 'inherit' : 'pipe' });
        console.log('npm is available');
      } catch (npmError) {
        console.error('Error checking npm:', npmError.message);
        return res.status(500).json({ error: 'npm/npx is not available on the server' });
      }
      
      // Explicitly install Fern CLI globally before using it
      console.log('Installing Fern CLI globally...');
      try {
        execSync('npm install -g fern-api', { 
          stdio: DEBUG ? 'inherit' : 'pipe',
          encoding: 'utf8' 
        });
        console.log('Fern CLI installed successfully');
      } catch (installError) {
        console.error('Error installing Fern CLI:', installError.message);
        console.error('Stderr:', installError.stderr);
        console.error('Stdout:', installError.stdout);
        return res.status(500).json({ 
          error: `Failed to install Fern CLI: ${installError.message}`,
          details: {
            stderr: installError.stderr,
            stdout: installError.stdout
          }
        });
      }
      
      // Initialize Fern project with better error handling
      console.log('Initializing Fern project...');
      try {
        const initOutput = execSync('fern init --local', { 
          cwd: workDir, 
          stdio: 'pipe',
          encoding: 'utf8'
        });
        if (DEBUG) console.log('Fern init output:', initOutput);
      } catch (initError) {
        console.error('Error initializing Fern project:', initError.message);
        console.error('Stderr:', initError.stderr);
        console.error('Stdout:', initError.stdout);
        return res.status(500).json({ 
          error: `Fern initialization failed: ${initError.message}`,
          details: {
            stderr: initError.stderr,
            stdout: initError.stdout
          }
        });
      }
      
      // Generate SDK with better error handling
      console.log(`Generating ${language} SDK...`);
      const generators = getGeneratorForLanguage(language);
      try {
        const genOutput = execSync(`fern generate ${generators}`, { 
          cwd: workDir, 
          stdio: 'pipe',
          encoding: 'utf8'
        });
        if (DEBUG) console.log('Fern generate output:', genOutput);
      } catch (genError) {
        console.error('Error generating SDK:', genError.message);
        console.error('Stderr:', genError.stderr);
        console.error('Stdout:', genError.stdout);
        return res.status(500).json({ 
          error: `SDK generation failed: ${genError.message}`,
          details: {
            stderr: genError.stderr,
            stdout: genError.stdout
          }
        });
      }
      
      console.log('SDK generation completed');
      
      // Create ZIP archive
      const zipPath = path.join(workDir, 'sdk.zip');
      await createZipArchive(workDir, zipPath);
      console.log(`Created ZIP archive at ${zipPath}`);
      
      // Send the ZIP file as a response
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename=${packageName}-${language}-sdk.zip`);
      fs.createReadStream(zipPath).pipe(res);
      
      // Schedule cleanup after response is sent
      res.on('finish', () => {
        try {
          fs.removeSync(workDir);
          console.log(`Cleaned up ${workDir}`);
        } catch (cleanupErr) {
          console.error('Error during cleanup:', cleanupErr);
        }
      });
    } catch (error) {
      // Clean up on error
      try { fs.removeSync(workDir); } catch (cleanupErr) { console.error('Error during cleanup:', cleanupErr); }
      throw error;
    }
  } catch (error) {
    console.error('Error generating SDK:', error);
    res.status(500).json({ error: `SDK generation failed: ${error.message}` });
  }
});

// Helper function to generate Fern config
function generateFernConfig(language, packageName, config) {
  let generators = '';
  
  switch (language) {
    case 'typescript':
      generators = `
  typescript:
    mode: client
    output:
      path: ./generated/typescript
    name: ${packageName}
    includeExamples: ${config.includeExamples || true}
    includeTests: ${config.includeTests || false}
    indentation: "2"
    header: |
      // Generated by Fern SDK Generator. DO NOT EDIT.`;
      break;
    case 'python':
      generators = `
  python:
    mode: client
    output:
      path: ./generated/python
    name: ${packageName}
    include_tests: ${config.includeTests || false}
    include_examples: ${config.includeExamples || true}`;
      break;
    case 'java':
      generators = `
  java:
    mode: client
    output:
      path: ./generated/java
    name: ${packageName}
    includes: 
      - examples: ${config.includeExamples || true}
      - tests: ${config.includeTests || false}`;
      break;
    case 'go':
      generators = `
  go:
    mode: client
    output:
      path: ./generated/go
    module-path: github.com/${packageName}/sdk
    include-examples: ${config.includeExamples || true}
    include-tests: ${config.includeTests || false}`;
      break;
    case 'ruby':
      generators = `
  ruby:
    mode: client
    output:
      path: ./generated/ruby
    name: ${packageName}
    include-examples: ${config.includeExamples || true}
    include-tests: ${config.includeTests || false}`;
      break;
    case 'csharp':
      generators = `
  csharp:
    mode: client
    output:
      path: ./generated/csharp
    name: ${packageName}
    include-examples: ${config.includeExamples || true}
    include-tests: ${config.includeTests || false}`;
      break;
    default:
      generators = `
  typescript:
    mode: client
    output:
      path: ./generated/typescript
    name: ${packageName}
    includeExamples: ${config.includeExamples || true}
    includeTests: ${config.includeTests || false}`;
  }
  
  return `
fern:
  version: 2
  generators:${generators}`;
}

// Helper function to get the appropriate generator command arguments for a language
function getGeneratorForLanguage(language) {
  switch (language) {
    case 'typescript': return '--typescript';
    case 'python': return '--python';
    case 'java': return '--java';
    case 'go': return '--go';
    case 'ruby': return '--ruby';
    case 'csharp': return '--csharp';
    default: return '--typescript'; // Default to TypeScript
  }
}

// Function to create a ZIP archive of the generated SDK
async function createZipArchive(sourceDir, outputPath) {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(outputPath);
    const archive = archiver('zip', {
      zlib: { level: 9 } // Maximum compression
    });
    
    output.on('close', () => {
      console.log(`Archive created: ${archive.pointer()} bytes`);
      resolve();
    });
    
    archive.on('error', (err) => {
      reject(err);
    });
    
    archive.pipe(output);
    
    // Add the generated directory to the archive
    const generatedDir = path.join(sourceDir, 'generated');
    if (fs.existsSync(generatedDir)) {
      archive.directory(generatedDir, 'generated');
    } else {
      console.warn('Warning: Generated directory not found');
    }
    
    archive.finalize();
  });
}

// Start the server
app.listen(port, () => {
  console.log(`Fern SDK Generator Server listening on port ${port}`);
  console.log('API Key protection:', API_KEY ? 'Enabled' : 'Disabled');
  console.log('Debug mode:', DEBUG ? 'Enabled' : 'Disabled');
});
