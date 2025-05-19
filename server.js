const express = require('express');
const fileUpload = require('express-fileupload');
const cors = require('cors');
const fs = require('fs-extra');
const path = require('path');
const { execSync } = require('child_process');
const archiver = require('archiver');
const dotenv = require('dotenv');

dotenv.config();

// Environment variables with defaults
const port = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || 'development-key'; // Default key for development
const DEBUG = process.env.DEBUG === 'true';

// Validate required environment variables
if (!process.env.PORT) {
  console.warn('Warning: PORT not set, using default port 3000');
}

if (!process.env.API_KEY) {
  console.warn('Warning: API_KEY not set, using development key');
}

const config = {
  orgName: process.env.ORG_NAME || 'craftman',
  fernCliVersion: process.env.FERN_CLI_VERSION || '0.61.19',
  maxFileSize: parseInt(process.env.MAX_FILE_SIZE || '52428800'), // 50MB in bytes
  tempDir: path.resolve(process.cwd(), process.env.TEMP_DIR || '/tmp'),
  // ... other config options
};

// Ensure temp directory exists
try {
  fs.ensureDirSync(config.tempDir);
  console.log(`Using temp directory: ${config.tempDir}`);
} catch (error) {
  console.error(`Failed to create temp directory: ${error.message}`);
  process.exit(1);
}

const app = express();
const logger = {
  info: (message, meta = {}) => {
    console.log(JSON.stringify({ level: 'info', message, ...meta }));
  },
  error: (message, meta = {}) => {
    console.error(JSON.stringify({ level: 'error', message, ...meta }));
  },
  warn: (message, meta = {}) => {
    console.warn(JSON.stringify({ level: 'warn', message, ...meta }));
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

// Helper function to list directory structure recursively
function listDirectoryRecursive(dir, indent = '') {
  const stats = fs.statSync(dir);
  if (!stats.isDirectory()) {
    return `${indent}${path.basename(dir)}`;
  }

  const items = fs.readdirSync(dir);
  const structure = [`${indent}${path.basename(dir)}/`];
  
  items.forEach(item => {
    const itemPath = path.join(dir, item);
    const itemStats = fs.statSync(itemPath);
    if (itemStats.isDirectory()) {
      structure.push(listDirectoryRecursive(itemPath, indent + '  '));
    } else {
      structure.push(`${indent}  ${item}`);
    }
  });
  
  return structure.join('\n');
}

// Common setup function for both /check and /generate endpoints
const setupFernProject = async (req, workDir, options = {}) => {
  try {
   
    // Validate request
    if (!req.files || !req.files.spec) {
      throw new Error('No OpenAPI spec file provided');
    }
    
    // Save spec file
    const specFile = req.files.spec;
    const specFilePath = path.join(workDir, 'openapi.yaml');
    try {
      await specFile.mv(specFilePath);
      logger.info(`Spec file saved to ${specFilePath}`);
    } catch (error) {
      logger.error('Error moving spec file:', error.message);
      throw new Error('Failed to move spec file to temp directory');
    }
    //Verify the spec file is moved to the temp directory
    if (!fs.existsSync(specFilePath)) {
      throw new Error('Spec file was not moved to the temp directory');
    }
    
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
      execSync(`npm install --omit=dev -g fern-api@${config.fernCliVersion || '0.61.18'}`, { 
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

    // Initialize Fern project with the OpenAPI spec
    logger.info('Initializing Fern project...');
    try {
      // Log directory structure before setup
      logger.info('Directory structure BEFORE setup:\n' + listDirectoryRecursive(workDir));

      // Create fern directory structure manually
      const fernDir = path.join(workDir, 'fern');
      fs.ensureDirSync(fernDir);
      logger.info('Created fern directory', { fernDir });

      // Create api directory and move spec file
      const apiDir = path.join(fernDir, 'openapi');
      fs.ensureDirSync(apiDir);
      const apiSpecPath = path.join(apiDir, 'openapi.yml');
      fs.copyFileSync(specFilePath, apiSpecPath);
      logger.info('Created api directory and copied spec file', { apiSpecPath });

      // Create fern.json configuration
      const fernConfig = {
        organization: config.orgName,
        version: config.fernCliVersion
      };
      const fernConfigPath = path.join(fernDir, 'fern.config.json');
      fs.writeFileSync(fernConfigPath, JSON.stringify(fernConfig, null, 2));
      logger.info('Created fern.config.json configuration', { fernConfigPath, fernConfig });

      // Create generators.yml file with appropriate content
      logger.info('Creating generators configuration...');
      let generatorsContent = generateFernGeneratorsConfig(options);
      
      // Write generators.yml to the fern directory
      const fernGeneratorsPath = path.join(fernDir, 'generators.yml');
      fs.writeFileSync(fernGeneratorsPath, generatorsContent);
      logger.info('Created generators.yml', { path: fernGeneratorsPath });
      
      // Create output directory for generated files
      const outputDir = path.join(fernDir, 'generated');
      fs.ensureDirSync(outputDir);
      logger.info('Created output directory', { outputDir });
      
      // Log final directory structure
      logger.info('Final directory structure:\n' + listDirectoryRecursive(workDir));
      
      return fernDir;
    } catch (initError) {
      logger.error('Error setting up Fern project:', {
        error: initError.message,
        stack: initError.stack,
        directoryStructure: listDirectoryRecursive(workDir)
      });
      throw new Error(`Failed to set up Fern project: ${initError.message}`);
    }
  } catch (error) {
    logger.error('Error in setupFernProject:', error);
    throw error;
  }
};

// Helper function to generate Fern generators config
function generateFernGeneratorsConfig(options) {
  let generators = '';
  
  switch (options.language) {
    case 'typescript':
      generators = `groups:
  typescript:
    generators:
      - name: fernapi/fern-typescript-node-sdk
        version: 1.0.0
        output:
          location: local-file-system
          path: ./generated
        config:
          outputSourceFiles: true
          includeExamples: ${options.includeExamples || true}
          includeTests: ${options.includeTests || false}`;
      break;
    case 'python':
      generators = `groups:
  python:
    generators:
      - name: fernapi/fern-python-sdk
        version: 4.20.2
        output:
          location: local-file-system
          path: ./generated/python
        config:
          outputSourceFiles: true
          include_examples: ${options.includeExamples || true}
          include_tests: ${options.includeTests || false}`;
      break;
    case 'java':
      generators = `groups:
  java:
    generators:
      - name: fernapi/fern-java-sdk
        version: 2.36.2
        output:
          location: local-file-system
          path: ./generated/java
        config:
          outputSourceFiles: true
          includes:
            examples: ${options.includeExamples || true}
            tests: ${options.includeTests || false}`;
      break;
    case 'go':
      generators = `groups:
  go:
    generators:
      - name: fernapi/fern-go-sdk
        version: 0.38.0
        output:
          location: local-file-system
          path: ./generated/go
        config:
          outputSourceFiles: true
          module-path: github.com/${options.packageName}/sdk
          include-examples: ${options.includeExamples || true}
          include-tests: ${options.includeTests || false}`;
      break;
    case 'ruby':
      generators = `groups:
  ruby:
    generators:
      - name: fernapi/fern-ruby-sdk
        version: 0.9.0-rc2
        output:
          location: local-file-system
          path: ./generated/ruby
        config:
          outputSourceFiles: true
          include-examples: ${options.includeExamples || true}
          include-tests: ${options.includeTests || false}`;
      break;
    case 'csharp':
      generators = `groups:
  csharp:
    generators:
      - name: fernapi/fern-csharp-sdk
        version: 1.17.4
        output:
          location: local-file-system
          path: ./generated/csharp
        config:
          outputSourceFiles: true
          include-examples: ${options.includeExamples || true}
          include-tests: ${options.includeTests || false}`;
      break;
    default:
      generators = `groups:
  typescript:
    generators:
      - name: fernapi/fern-typescript-node-sdk
        version: 1.0.0
        output:
          location: local-file-system
          path: ./generated/typescript
        config:
          outputSourceFiles: true
          includeExamples: ${options.includeExamples || true}
          includeTests: ${options.includeTests || false}`;
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

  const options = req.body.config ? JSON.parse(req.body.config) : { language: 'typescript', packageName: 'api-client' };
  // Use isCheckOnly flag
  options.isCheckOnly = true;

  // Create a unique working directory
  const workDir = path.join(config.tempDir, `fern-check-${Date.now()}`);
  fs.ensureDirSync(workDir);
  
  try {
    
    const fernDir = await setupFernProject(req, workDir, options);
    
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

  const options = req.body.config ? JSON.parse(req.body.config) : { language: 'typescript', packageName: 'api-client' };
  // Use isCheckOnly flag
  options.isCheckOnly = false;
  
  try {
    // Validate request parameters
    if (!req.files || !req.files.spec) {
      logger.error('No spec file provided in request');
      return res.status(400).json({ error: 'OpenAPI spec file is required' });
    }
    
    // Create a unique working directory
    const workDir = path.join(config.tempDir, `fern-${Date.now()}`);
    logger.info('Creating work directory', { workDir });
    fs.ensureDirSync(workDir);
    
    try {
      
      // Use common setup function with generation options
      logger.info('Setting up Fern project (version: '+config.fernCliVersion+')');
      const fernDir = await setupFernProject(req, workDir, options);
      
      // Generate SDK with better error handling
      logger.info(`Generating ${options.language} SDK...`);
      try {
        // Log the working directory structure before generation
        logger.info('Working directory structure before generation:', {
          workDir,
          contents: fs.readdirSync(workDir)
        });

        // Use --local flag for local generation in Docker
        logger.info('Running Fern generate command...');
        const genOutput = execSync('fern generate --local --group ' + options.language, { 
          cwd: workDir, 
          stdio: 'pipe',
          encoding: 'utf8'
        });
        
        // Log the full Fern output
        logger.info('Fern generate command output:', {
          output: genOutput,
          workDir
        });

        // Verify the generated directory exists and log its contents
        const generatedDir = path.join(workDir, 'generated');
        if (!fs.existsSync(generatedDir)) {
          logger.error('Generated directory not found after Fern generation', {
            workDir,
            contents: fs.readdirSync(workDir)
          });
          throw new Error('Generated directory was not created by Fern');
        }

        // Log the contents of the generated directory
        const generatedContents = fs.readdirSync(generatedDir);
        logger.info('Generated directory contents:', {
          generatedDir,
          contents: generatedContents,
          fileCount: generatedContents.length
        });

        logger.info('Generated directory verified', { generatedDir });
      } catch (genError) {
        logger.error('Error generating SDK:', {
          error: genError.message,
          stderr: genError.stderr,
          stdout: genError.stdout,
          code: genError.code,
          signal: genError.signal,
          workDir,
          workDirContents: fs.existsSync(workDir) ? fs.readdirSync(workDir) : 'Directory not found'
        });
        return res.status(500).json({ 
          error: `SDK generation failed: ${genError.message}`,
          details: {
            stderr: genError.stderr,
            stdout: genError.stdout,
            code: genError.code
          }
        });
      }
      
      logger.info('SDK generation completed');
      
      // Create ZIP archive
      const zipPath = path.join(workDir, 'sdk.zip');
      logger.info('Creating ZIP archive', { zipPath });
      try {
        await createZipArchive(workDir, zipPath);
        logger.info(`Created ZIP archive at ${zipPath}`);
      } catch (zipError) {
        logger.error('Error creating ZIP archive:', {
          error: zipError.message,
          stack: zipError.stack
        });
        return res.status(500).json({ 
          error: `Failed to create ZIP archive: ${zipError.message}`,
          details: DEBUG ? {
            stack: zipError.stack
          } : undefined
        });
      }
      
      // Send the ZIP file as a response
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename=${options.packageName}-${options.language}-sdk.zip`);
      
      try {
        fs.createReadStream(zipPath).pipe(res);
      } catch (streamError) {
        logger.error('Error streaming ZIP file:', {
          error: streamError.message,
          stack: streamError.stack
        });
        return res.status(500).json({ 
          error: `Failed to stream ZIP file: ${streamError.message}`
        });
      }
      
      // Schedule cleanup after response is sent
      res.on('finish', async () => {
        try {
          await cleanupWorkDir(workDir);
        } catch (cleanupErr) {
          logger.error('Error during cleanup:', {
            error: cleanupErr.message,
            stack: cleanupErr.stack
          });
        }
      });
    } catch (error) {
      // Clean up on error
      logger.error('Error in generate endpoint:', {
        error: error.message,
        stack: error.stack,
        workDir
      });
      await cleanupWorkDir(workDir);
      throw error;
    }
  } catch (error) {
    logger.error('Unhandled error in generate endpoint:', {
      error: error.message,
      stack: error.stack
    });
    res.status(500).json({ 
      error: 'Internal server error',
      details: DEBUG ? {
        message: error.message,
        stack: error.stack
      } : undefined
    });
  }
});

// Function to create a ZIP archive of the generated SDK
async function createZipArchive(sourceDir, outputPath) {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(outputPath);
    const archive = archiver('zip', {
      zlib: { level: 9 } // Maximum compression
    });
    
    output.on('close', () => {
      const size = archive.pointer();
      if (size === 0) {
        reject(new Error('No files were generated to archive'));
        return;
      }
      logger.info(`Archive created: ${size} bytes`);
      resolve();
    });
    
    archive.on('error', (err) => {
      reject(err);
    });
    
    archive.pipe(output);
    
    // Add the generated directory to the archive
    const generatedDir = path.join(sourceDir, 'generated');
    if (fs.existsSync(generatedDir)) {
      // Check if the directory is empty
      const files = fs.readdirSync(generatedDir);
      if (files.length === 0) {
        reject(new Error('Generated directory is empty'));
        return;
      }
      logger.info('Adding files to archive', { 
        directory: generatedDir,
        fileCount: files.length
      });
      archive.directory(generatedDir, 'generated');
    } else {
      reject(new Error('Generated directory not found'));
      return;
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

// Add error handling middleware
app.use((err, req, res, next) => {
  logger.error('Unhandled error:', err);
  res.status(500).json({
    error: 'Internal server error',
    message: DEBUG ? err.message : 'An unexpected error occurred'
  });
});

// Add process error handlers
process.on('uncaughtException', (err) => {
  logger.error('Uncaught Exception:', err);
  // Give time for logging before exit
  setTimeout(() => process.exit(1), 1000);
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
  // Give time for logging before exit
  setTimeout(() => process.exit(1), 1000);
});

// Start the server
app.listen(port, () => {
  logger.info(`Fern SDK Generator Server listening on port ${port}`);
  logger.info('API Key protection:', API_KEY ? 'Enabled' : 'Disabled');
  logger.info('Debug mode:', DEBUG ? 'Enabled' : 'Disabled');
});
