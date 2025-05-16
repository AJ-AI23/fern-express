
# Fern SDK Generator Server

This server enables generation of SDKs from OpenAPI specifications using the Fern CLI.

## Setup

### Prerequisites
- Node.js 14+
- npm or yarn

### Installation
1. Clone this repository
2. Install dependencies:
   ```
   npm install
   ```
   or
   ```
   yarn
   ```
3. Create a `.env` file with:
   ```
   PORT=3000
   API_KEY=your_secure_api_key_here
   ```

### Running the server
```
npm start
```
or
```
yarn start
```

## Usage

### Generate an SDK
```
POST /generate
```

Headers:
- `x-api-key`: Your API key (if enabled)

Body (form-data):
- `spec`: OpenAPI specification file (YAML or JSON)
- `language`: Target language (typescript, python, java, go, ruby, csharp)
- `packageName`: Name for the generated SDK package
- `config`: JSON string with additional configuration options

### Health Check
```
GET /health
```

## Deployment
This server is designed to be deployed on Railway.app.

### Environment Variables for Railway
- `PORT`: Automatically set by Railway
- `API_KEY`: Your secure API key for authentication

## License
MIT
