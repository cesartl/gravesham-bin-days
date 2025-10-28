const { google } = require('googleapis');

(async () => {
  const { GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN, GMAIL_SENDER } = process.env;
  const oauth2 = new google.auth.OAuth2(GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET);
  oauth2.setCredentials({ refresh_token: GMAIL_REFRESH_TOKEN });
  const gmail = google.gmail({ version: 'v1', auth: oauth2 });

  const to = process.env.TEST_TO || GMAIL_SENDER;
  const subject = 'Gravesham bins test email';
  const text = 'This is a test from the local Gmail setup.';

  const raw = Buffer.from(
    `From: ${GMAIL_SENDER}\nTo: ${to}\nSubject: ${subject}\nMIME-Version: 1.0\nContent-Type: text/plain; charset=utf-8\n\n${text}`
  ).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');

  await gmail.users.messages.send({ userId: 'me', requestBody: { raw } });
  console.log('Sent to', to);
})();