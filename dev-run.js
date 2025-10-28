process.env.LOCAL_CHROME = process.env.LOCAL_CHROME || '1';
process.env.SOURCE_URL = process.env.SOURCE_URL || 'https://my.gravesham.gov.uk/en/AchieveForms/?form_uri=sandbox-publish://AF-Process-22218d5c-c6d6-492f-b627-c713771126be/AF-Stage-905e87c1-144b-4a72-8932-5518ddd3e618/definition.json&redirectlink=%2Fen&cancelRedirectLink=%2Fen&consentMessage=yes';
process.env.TZ = 'Europe/London';

const handler = require('./handler');

handler.daily({ forceNotify: true })
  .then((res) => {
    console.log('Done:', res);
    process.exit(0);
  })
  .catch((err) => {
    console.error('Error:', err);
    process.exit(1);
  });


