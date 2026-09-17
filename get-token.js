const { google } = require('googleapis');
const http = require('http');
const url = require('url');
const opn = require('open'); // Optional: npm install open, or just open the link manually

const CLIENT_ID = '663184642216-flsdbchte7fqt83d7o1bvg4kkaguvks0.apps.googleusercontent.com';
const CLIENT_SECRET = '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';
const REDIRECT_URI = 'http://localhost:3000';

const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);

const scopes = ['https://www.googleapis.com/auth/youtube.upload'];

const authorizeUrl = oauth2Client.generateAuthUrl({
  access_type: 'offline',
  scope: scopes,
  prompt: 'consent'
});

const server = http.createServer(async (req, res) => {
  if (req.url.startsWith('/?code=')) {
    const qs = new url.URL(req.url, 'http://localhost:3000').searchParams;
    const code = qs.get('code');
    res.end('Authentication successful! You can close this tab.');
    server.close();

    const { tokens } = await oauth2Client.getToken(code);
    console.log('\n--- YOUR REFRESH TOKEN ---');
    console.log(tokens.refresh_token);
    console.log('--------------------------\n');
  }
});

server.listen(3000, async () => {
  console.log('Authorize this app by visiting this url:', authorizeUrl);
  // Opens browser automatically (or copy-paste the URL above)
  try {
    await (await import('open')).default(authorizeUrl);
  } catch (e) {
    // ignore if open package isn't installed, just copy link from console
  }
});

