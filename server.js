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

const config = {
  fernCliVersion: process.env.FERN_CLI_VERSION || '0.61.18',
  maxFileSize: parseInt(process.env.MAX_FILE_SIZE || '52428800'), // 50MB in bytes
  tempDir: process.env.TEMP_DIR || './tmp',
  // ... other config options
};

const logger = {
  info: (message, meta = {}) => {
    console.log(JSON.stringify({ level: 'info', message, ...meta }));
  },
  error: (message, meta = {}) => {
    console.error(JSON.stringify({ level: 'error', message, ...meta }));
  }
};

// Middleware
app.use(cors());
app.use(express.json());
app.use(fileUpload({
  limits: { fileSize: config.maxFileSize },
  useTempFiles: true,
  tempFileDir: config.tempDir
}));

// Create tmp directory if it doesn't exist
fs.ensureDirSync(config.tempDir);

// API Key middleware
const checkApiKey = (req, res, next) => {
  if (!API_KEY) {
    return res.status(500).json({ error: 'Server configuration error: API_KEY not set' });
  }
  
  const providedKey = req.headers['x-api-key'];
  if (!providedKey || providedKey !== API_KEY) {
    return res.status(401).json({ error: 'Unauthorized - Invalid API Key' });
  }
  
  next();
};

// Common setup function for both /check and /generate endpoints
const setupFernProject = async (req, workDir, specFilePath, options = {}) => {
  // Extract options with defaults
  const language = options.language || 'typescript';
  const packageName = options.packageName || 'api-client';
  const config = options.config || {};
  const isCheckOnly = options.isCheckOnly || false;
  
  // Validate request
  if (!req.files || !req.files.spec) {
    throw new Error('No OpenAPI spec file provided');
  }
  
  // Save spec file
  const specFile = req.files.spec;
  await specFile.mv(specFilePath);
  logger.info(`Spec file saved to ${specFilePath}`);
  
  // Check for npm installation
  logger.info('Verifying npm availability...');
  try {
    execSync('npm --version', { stdio: DEBUG ? 'inherit' : 'pipe' });
    logger.info('npm is available');
  } catch (npmError) {
    logger.error('Error checking npm:', npmError.message);
    throw new Error('npm is not available on the server');
  }
  
  // Explicitly install Fern CLI globally before using it
  logger.info('Installing Fern CLI globally...');
  try {
    execSync(`npm install -g fern-api@${config.fernCliVersion}`, { 
      stdio: DEBUG ? 'inherit' : 'pipe',
      encoding: 'utf8' 
    });
    logger.info('Fern CLI installed successfully');
  } catch (installError) {
    logger.error('Error installing Fern CLI:', installError.message);
    logger.error('Stderr:', installError.stderr);
    logger.error('Stdout:', installError.stdout);
    throw new Error(`Failed to install Fern CLI: ${installError.message}`);
  }
  
  // Create Fern project structure
  const fernDir = path.join(workDir, 'fern');
  logger.info('Creating Fern project structure...');
  fs.ensureDirSync(fernDir);
  
  // Create the openapi directory inside fern
  const openapiDir = path.join(fernDir, 'openapi');
  fs.ensureDirSync(openapiDir);
  
  // Copy the spec file to the openapi directory
  fs.copySync(specFilePath, path.join(openapiDir, 'openapi.yaml'));
  
  // Create a basic fern.config.json in the fern directory
  fs.writeFileSync(path.join(fernDir, 'fern.config.json'), JSON.stringify({
    "organization": "user",
    "version": "0.1.0"
  }));
  
  // Create generators.yml file with appropriate content
  logger.info('Creating generators configuration...');
  let generatorsContent;
  
  if (isCheckOnly) {
    // For check endpoint, create a minimal generators file
    generatorsContent = '# Minimal generators file for validation';
  } else {
    // For generate endpoint, create a full generators config
    generatorsContent = generateFernGeneratorsConfig(language, packageName, config);
  }
  
  // Write generators.yml to both locations to ensure compatibility
  const fernGeneratorsPath = path.join(fernDir, 'generators.yml');
  fs.writeFileSync(fernGeneratorsPath, generatorsContent);
  
  const openapiGeneratorsPath = path.join(openapiDir, 'generators.yml');
  fs.writeFileSync(openapiGeneratorsPath, generatorsContent);
  
  logger.info('Created Fern generators.yml files');
  
  logger.info('Fern project structure created');
  return fernDir;
};

// Helper function to generate Fern generators config
function generateFernGeneratorsConfig(language, packageName, config) {
  let generators = '';
  
  switch (language) {
    case 'typescript':
      generators = `
typescript:
  mode: client
  output:
    location: local
    path: ./generated/typescript
  name: ${packageName}
  includeExamples: ${config.includeExamples || true}
  includeTests: ${config.includeTests || false}`;
      break;
    case 'python':
      generators = `
python:
  mode: client
  output:
    location: local
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
    location: local
    path: ./generated/java
  name: ${packageName}
  includes:
    examples: ${config.includeExamples || true}
    tests: ${config.includeTests || false}`;
      break;
    case 'go':
      generators = `
go:
  mode: client
  output:
    location: local
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
    location: local
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
    location: local
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
    location: local
    path: ./generated/typescript
  name: ${packageName}
  includeExamples: ${config.includeExamples || true}
  includeTests: ${config.includeTests || false}`;
  }
  
  return generators;
}

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'OK', message: 'Fern SDK Generator Server is running' });
});

class ValidationError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'ValidationError';
    this.details = details;
  }
}

// New endpoint: Validate OpenAPI spec using Fern check command
app.post('/check', checkApiKey, async (req, res) => {
  logger.info('Received OpenAPI validation request');
  
  // Validate request parameters
  if (!req.body.language) {
    return res.status(400).json({ error: 'Language parameter is required' });
  }

  if (!req.body.packageName) {
    return res.status(400).json({ error: 'Package name is required' });
  }

  const language = req.body.language;
  const packageName = req.body.packageName;
  const requestConfig = req.body.config ? JSON.parse(req.body.config) : {};
  // Use isCheckOnly flag
  requestConfig.isCheckOnly = true;

  // Create a unique working directory
  const workDir = path.join(config.tempDir, `fern-check-${Date.now()}`);
  fs.ensureDirSync(workDir);
  
  try {
    const specFilePath = path.join(workDir, 'openapi.yaml');
    
    const fernDir = await setupFernProject(req, workDir, specFilePath, {
      language,
      packageName,
      config: requestConfig
    });
    
    // Run Fern check command
    logger.info('Running Fern check command...');
    try {
      execSync('fern check', { 
        cwd: workDir, 
        stdio: 'pipe',
        encoding: 'utf8' 
      });
      
      logger.info('Validation passed, no errors found');
      res.json({ 
        valid: true,
        message: 'OpenAPI specification is valid',
        fernDir: fernDir
      });
    } catch (checkError) {
      logger.error('Validation errors found:', checkError.message);
      logger.error('Stderr:', checkError.stderr);
      logger.error('Stdout:', checkError.stdout);
      
      // Parse validation errors and return them
      let validationErrors = [];
      
      // Extract meaningful error information from stderr or stdout
      const errorOutput = checkError.stderr || checkError.stdout;
      if (errorOutput) {
        // Basic error extraction - could be enhanced with more sophisticated parsing
        validationErrors = errorOutput
          .split('\n')
          .filter(line => line.trim().length > 0)
          .map(line => line.trim());
      }
      
      throw new ValidationError('OpenAPI specification has validation errors', {
        errors: validationErrors,
        details: {
          stderr: checkError.stderr,
          stdout: checkError.stdout
        }
      });
    }
  } catch (error) {
    if (error instanceof ValidationError) {
      return res.status(400).json({
        error: error.message,
        details: error.details
      });
    }
    logger.error('Error validating OpenAPI spec:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// SDK Generation endpoint
app.post('/generate', checkApiKey, async (req, res) => {
  logger.info('Received SDK generation request');
  
  try {
    // Validate request parameters
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
    const workDir = path.join(config.tempDir, `fern-${Date.now()}`);
    fs.ensureDirSync(workDir);
    
    try {
      const specFilePath = path.join(workDir, 'openapi.yaml');
      
      // Use common setup function with generation options
      const fernDir = await setupFernProject(req, workDir, specFilePath, {
        language,
        packageName,
        config
      });
      
      // Generate SDK with better error handling
      logger.info(`Generating ${language} SDK...`);
      try {
        // Use --local flag for local generation in Docker
        const genOutput = execSync('fern generate --local', { 
          cwd: workDir, 
          stdio: 'pipe',
          encoding: 'utf8'
        });
        if (DEBUG) logger.info('Fern generate output:', genOutput);
      } catch (genError) {
        logger.error('Error generating SDK:', genError.message);
        logger.error('Stderr:', genError.stderr);
        logger.error('Stdout:', genError.stdout);
        return res.status(500).json({ 
          error: `SDK generation failed: ${genError.message}`,
          details: {
            stderr: genError.stderr,
            stdout: genError.stdout
          }
        });
      }
      
      logger.info('SDK generation completed');
      
      // Create ZIP archive
      const zipPath = path.join(workDir, 'sdk.zip');
      await createZipArchive(workDir, zipPath);
      logger.info(`Created ZIP archive at ${zipPath}`);
      
      // Send the ZIP file as a response
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename=${packageName}-${language}-sdk.zip`);
      fs.createReadStream(zipPath).pipe(res);
      
      // Schedule cleanup after response is sent
      res.on('finish', async () => {
        try {
          await cleanupWorkDir(workDir);
        } catch (cleanupErr) {
          logger.error('Error during cleanup:', cleanupErr);
        }
      });
    } catch (error) {
      // Clean up on error
      await cleanupWorkDir(workDir);
      throw error;
    }
  } catch (error) {
    logger.error('Error generating SDK:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Helper function to get the appropriate generator command arguments for a language (no longer needed)
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
      logger.info(`Archive created: ${archive.pointer()} bytes`);
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
      logger.warn('Warning: Generated directory not found');
    }
    
    archive.finalize();
  });
}

async function cleanupWorkDir(workDir) {
  try {
    await fs.remove(workDir);
    logger.info(`Cleaned up directory: ${workDir}`);
  } catch (error) {
    logger.error(`Failed to cleanup directory: ${workDir}`, { error: error.message });
  }
}

// Start the server
app.listen(port, () => {
  logger.info(`Fern SDK Generator Server listening on port ${port}`);
  logger.info('API Key protection:', API_KEY ? 'Enabled' : 'Disabled');
  logger.info('Debug mode:', DEBUG ? 'Enabled' : 'Disabled');
});
