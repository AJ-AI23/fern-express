
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

// New endpoint: Validate OpenAPI spec using Fern check command
app.post('/check', checkApiKey, async (req, res) => {
  console.log('Received OpenAPI validation request');
  
  try {
    // Validate request
    if (!req.files || !req.files.spec) {
      return res.status(400).json({ error: 'No OpenAPI spec file provided' });
    }
    
    // Create a unique working directory
    const workDir = path.join('./tmp', `fern-check-${Date.now()}`);
    fs.ensureDirSync(workDir);
    
    try {
      // Save spec file
      const specFile = req.files.spec;
      const specFilePath = path.join(workDir, 'openapi.yaml');
      await specFile.mv(specFilePath);
      console.log(`Spec file saved to ${specFilePath}`);
      
      // Check for npm installation
      try {
        console.log('Verifying npm availability...');
        execSync('npm --version', { stdio: DEBUG ? 'inherit' : 'pipe' });
        console.log('npm is available');
      } catch (npmError) {
        console.error('Error checking npm:', npmError.message);
        return res.status(500).json({ error: 'npm is not available on the server' });
      }
      
      // Explicitly install Fern CLI globally before using it
      console.log('Installing Fern CLI globally...');
      try {
        execSync('npm install -g fern-api@0.61.18', { 
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
      
      // Setup Fern directory structure for validation
      const fernDir = path.join(workDir, 'fern');
      
      console.log('Creating Fern project structure for validation...');
      try {
        fs.ensureDirSync(fernDir);
        
        // Create the openapi directory inside fern
        const openapiDir = path.join(fernDir, 'openapi');
        fs.ensureDirSync(openapiDir);
        
        // Copy the spec file to the openapi directory
        fs.copySync(specFilePath, path.join(openapiDir, 'openapi.yaml'));
        
        // Create a basic fern.config.json
        fs.writeFileSync(path.join(fernDir, 'fern.config.json'), JSON.stringify({
          "organization": "user",
          "version": "0.1.0"
        }));
        
        console.log('Fern project structure created for validation');
      } catch (initError) {
        console.error('Error creating Fern project structure:', initError.message);
        return res.status(500).json({ 
          error: `Fern project structure creation failed: ${initError.message}`
        });
      }
      
      // Run Fern check command
      console.log('Running Fern check command...');
      try {
        execSync('fern check', { 
          cwd: workDir, 
          stdio: 'pipe',
          encoding: 'utf8' 
        });
        
        console.log('Validation passed, no errors found');
        res.json({ 
          valid: true,
          message: 'OpenAPI specification is valid'
        });
      } catch (checkError) {
        console.error('Validation errors found:', checkError.message);
        console.error('Stderr:', checkError.stderr);
        console.error('Stdout:', checkError.stdout);
        
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
        
        return res.status(400).json({
          valid: false,
          message: 'OpenAPI specification has validation errors',
          errors: validationErrors,
          details: {
            stderr: checkError.stderr,
            stdout: checkError.stdout
          }
        });
      } finally {
        // Clean up after validation
        try {
          fs.removeSync(workDir);
          console.log(`Cleaned up validation directory ${workDir}`);
        } catch (cleanupErr) {
          console.error('Error during cleanup:', cleanupErr);
        }
      }
    } catch (error) {
      // Cleanup on error
      try { fs.removeSync(workDir); } catch (cleanupErr) { console.error('Error during cleanup:', cleanupErr); }
      throw error;
    }
  } catch (error) {
    console.error('Error validating OpenAPI spec:', error);
    res.status(500).json({ error: `Validation failed: ${error.message}` });
  }
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
      
      // Check for npm installation
      try {
        console.log('Verifying npm availability...');
        execSync('npm --version', { stdio: DEBUG ? 'inherit' : 'pipe' });
        console.log('npm is available');
      } catch (npmError) {
        console.error('Error checking npm:', npmError.message);
        return res.status(500).json({ error: 'npm is not available on the server' });
      }
      
      // Explicitly install Fern CLI globally before using it
      console.log('Installing Fern CLI globally...');
      try {
        execSync('npm install -g fern-api@0.61.18', { 
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
      
      // Define fernDir outside the try block so it's accessible throughout the function
      const fernDir = path.join(workDir, 'fern');
      
      // Initialize Fern project with OpenAPI spec
      console.log('Initializing Fern project with OpenAPI spec...');
      try {
        // Create the fern directory structure manually
        fs.ensureDirSync(fernDir);
        
        // Create the openapi directory inside fern
        const openapiDir = path.join(fernDir, 'openapi');
        fs.ensureDirSync(openapiDir);
        
        // Copy the spec file to the openapi directory
        fs.copySync(specFilePath, path.join(openapiDir, 'openapi.yaml'));
        
        // Create a basic fern.config.json
        fs.writeFileSync(path.join(fernDir, 'fern.config.json'), JSON.stringify({
          "organization": "user",
          "version": "0.1.0"
        }));
        
        console.log('Fern project structure created manually');
      } catch (initError) {
        console.error('Error creating Fern project structure:', initError.message);
        return res.status(500).json({ 
          error: `Fern project structure creation failed: ${initError.message}`
        });
      }
      
      // Generate generators.yml in the fern directory
      console.log('Creating generators configuration...');
      const generatorsContent = generateFernGeneratorsConfig(language, packageName, config);
      const generatorsPath = path.join(fernDir, 'generators.yml');
      fs.writeFileSync(generatorsPath, generatorsContent);
      console.log('Created Fern generators.yml file');
      
      // Generate SDK with better error handling
      console.log(`Generating ${language} SDK...`);
      try {
        // Use --local flag for local generation in Docker
        const genOutput = execSync('fern generate --local', { 
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
